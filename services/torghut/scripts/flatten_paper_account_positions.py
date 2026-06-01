#!/usr/bin/env python3
"""Flatten the Torghut paper account so runtime proof windows start clean."""

from __future__ import annotations

import argparse
import json
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Protocol, cast

from app.alpaca_client import TorghutAlpacaClient
from app.config import settings
from app.db import SessionLocal
from app.snapshots import snapshot_account_and_positions
from app.trading.firewall import OrderFirewall

DEFAULT_ACCOUNT_LABEL = "TORGHUT_SIM"
DEFAULT_PAPER_BASE_URL = "https://paper-api.alpaca.markets"
DEFAULT_MAX_GROSS_MARKET_VALUE = Decimal("100000")
DEFAULT_MAX_POSITION_COUNT = 25
DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS = Decimal("200")
DEFAULT_WAIT_FLAT_SECONDS = 0.0
DEFAULT_POLL_SECONDS = 5.0
TERMINAL_CLEAN_STATUSES = frozenset({"clean", "dry_run", "submitted", "flattened"})


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
    reference_price: Decimal | None

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
    parser.add_argument(
        "--extended-hours-limit",
        action="store_true",
        help=(
            "Use aggressive extended-hours limit orders instead of regular-session "
            "market orders. Still paper-only and account-label guarded."
        ),
    )
    parser.add_argument(
        "--limit-away-bps",
        default=str(DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS),
        help=(
            "Basis points away from the position reference price for extended-hours "
            "limit closes: sells below reference, buys above reference."
        ),
    )
    parser.add_argument(
        "--wait-flat-seconds",
        type=float,
        default=DEFAULT_WAIT_FLAT_SECONDS,
        help="Poll the account after submitting close orders and fail if positions remain after this many seconds.",
    )
    parser.add_argument(
        "--poll-seconds",
        type=float,
        default=DEFAULT_POLL_SECONDS,
        help="Polling interval used with --wait-flat-seconds.",
    )
    parser.add_argument(
        "--persist-snapshot",
        action="store_true",
        help="Persist a fresh PositionSnapshot after the flatten attempt for runtime-window readiness gates.",
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


def _position_reference_price(
    position: Mapping[str, Any], qty: Decimal, market_value: Decimal
) -> Decimal | None:
    for key in (
        "current_price",
        "currentPrice",
        "lastday_price",
        "lastdayPrice",
        "avg_entry_price",
        "avgEntryPrice",
    ):
        price = _decimal(position.get(key))
        if price > 0:
            return price
    abs_qty = abs(qty)
    if abs_qty > 0 and market_value > 0:
        return market_value / abs_qty
    return None


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
        market_value = _position_market_value(raw, qty)
        normalized.append(
            FlattenPosition(
                symbol=symbol,
                qty=qty,
                side=side,
                market_value=market_value,
                reference_price=_position_reference_price(raw, qty, market_value),
            )
        )
    return sorted(normalized, key=lambda item: item.symbol)


def _position_payload(position: FlattenPosition) -> dict[str, str | None]:
    return {
        "symbol": position.symbol,
        "qty": str(position.qty),
        "side": position.side,
        "market_value": str(position.market_value),
        "reference_price": str(position.reference_price)
        if position.reference_price is not None
        else None,
        "close_side": position.close_side,
        "close_qty": str(position.close_qty),
    }


def _quantize_price(price: Decimal) -> Decimal:
    quantum = Decimal("0.01") if price >= Decimal("1") else Decimal("0.0001")
    return price.quantize(quantum, rounding=ROUND_HALF_UP)


def _extended_hours_limit_price(
    position: FlattenPosition, limit_away_bps: Decimal
) -> Decimal | None:
    reference = position.reference_price
    if reference is None or reference <= 0:
        return None
    away = max(Decimal("0"), limit_away_bps) / Decimal("10000")
    if position.close_side == "sell":
        raw_price = reference * (Decimal("1") - away)
    else:
        raw_price = reference * (Decimal("1") + away)
    if raw_price <= 0:
        raw_price = Decimal("0.0001")
    return _quantize_price(raw_price)


def _wait_until_flat(
    *,
    client: PaperFlattenClient,
    deadline_seconds: float,
    poll_seconds: float,
) -> tuple[str, list[FlattenPosition]]:
    deadline = time.monotonic() + max(0.0, deadline_seconds)
    latest_positions = _normalize_positions(client.list_positions())
    while latest_positions:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "submitted_not_flat", latest_positions
        time.sleep(min(max(0.1, poll_seconds), remaining))
        latest_positions = _normalize_positions(client.list_positions())
    return "flattened", []


def flatten_paper_account_positions(
    *,
    client: PaperFlattenClient,
    account_label: str,
    expected_account_label: str,
    trading_mode: str,
    apply: bool,
    max_gross_market_value: Decimal,
    max_position_count: int,
    extended_hours_limit: bool = False,
    limit_away_bps: Decimal = DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS,
    wait_flat_seconds: float = DEFAULT_WAIT_FLAT_SECONDS,
    poll_seconds: float = DEFAULT_POLL_SECONDS,
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
    extended_limit_prices: dict[str, Decimal] = {}
    missing_limit_symbols: list[str] = []
    if extended_hours_limit:
        for position in positions:
            limit_price = _extended_hours_limit_price(position, limit_away_bps)
            if limit_price is None:
                missing_limit_symbols.append(position.symbol)
            else:
                extended_limit_prices[position.symbol] = limit_price
        if missing_limit_symbols:
            blockers.append("paper_account_flatten_extended_hours_limit_price_missing")

    status = "clean" if not positions and not blockers else "blocked"
    cancelled_orders: list[dict[str, Any]] = []
    submitted_orders: list[dict[str, Any]] = []
    rejected_close_orders: list[dict[str, Any]] = []
    final_positions = positions
    if blockers:
        status = "blocked"
    elif not apply:
        status = "dry_run" if positions else "clean"
    elif positions:
        cancelled_orders = client.cancel_all_orders()
        for position in positions:
            order_type = "limit" if extended_hours_limit else "market"
            limit_price = extended_limit_prices.get(position.symbol)
            extra_params: dict[str, Any] = {
                "client_order_id": (
                    "torghut-paper-flatten-"
                    f"{generated_at.strftime('%Y%m%d%H%M%S')}-"
                    f"{position.symbol.lower()}"
                )
            }
            if extended_hours_limit:
                extra_params["extended_hours"] = True
            try:
                submitted_orders.append(
                    client.submit_order(
                        symbol=position.symbol,
                        side=position.close_side,
                        qty=float(position.close_qty),
                        order_type=order_type,
                        time_in_force="day",
                        limit_price=float(limit_price)
                        if limit_price is not None
                        else None,
                        extra_params=extra_params,
                    )
                )
            except Exception as exc:
                rejected_close_orders.append(
                    {
                        "symbol": position.symbol,
                        "side": position.close_side,
                        "qty": str(position.close_qty),
                        "order_type": order_type,
                        "reason": "paper_account_flatten_close_order_rejected",
                        "error_type": type(exc).__name__,
                        "error": str(exc),
                    }
                )
        if rejected_close_orders:
            blockers.append("paper_account_flatten_close_order_rejected")
            status = "failed_close_orders"
        elif wait_flat_seconds > 0:
            status, final_positions = _wait_until_flat(
                client=client,
                deadline_seconds=wait_flat_seconds,
                poll_seconds=poll_seconds,
            )
        else:
            status = "submitted"

    return {
        "schema_version": "torghut.paper-account-flatten.v1",
        "status": status,
        "apply": apply,
        "extended_hours_limit": extended_hours_limit,
        "limit_away_bps": str(limit_away_bps),
        "wait_flat_seconds": wait_flat_seconds,
        "poll_seconds": poll_seconds,
        "generated_at": generated_at.isoformat(),
        "account_label": normalized_label,
        "expected_account_label": expected_label,
        "trading_mode": normalized_mode,
        "position_count": len(positions),
        "final_position_count": len(final_positions),
        "gross_market_value": str(gross_market_value),
        "max_gross_market_value": str(max_gross_market_value),
        "max_position_count": max_position_count,
        "blockers": blockers,
        "rejected_close_order_count": len(rejected_close_orders),
        "rejected_close_orders": rejected_close_orders,
        "extended_hours_limit_missing_symbols": missing_limit_symbols,
        "positions": [_position_payload(position) for position in positions],
        "final_positions": [
            _position_payload(position) for position in final_positions
        ],
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
    limit_away_bps = _decimal(
        args.limit_away_bps,
        default=DEFAULT_EXTENDED_HOURS_LIMIT_AWAY_BPS,
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
        extended_hours_limit=bool(args.extended_hours_limit),
        limit_away_bps=limit_away_bps,
        wait_flat_seconds=max(0.0, float(args.wait_flat_seconds or 0.0)),
        poll_seconds=max(0.1, float(args.poll_seconds or DEFAULT_POLL_SECONDS)),
    )
    if args.persist_snapshot:
        if (
            payload["trading_mode"] == "paper"
            and payload["account_label"] == payload["expected_account_label"]
        ):
            with SessionLocal() as session:
                snapshot = snapshot_account_and_positions(
                    session,
                    cast(Any, firewall),
                    str(args.account_label or ""),
                )
            payload["position_snapshot_id"] = str(snapshot.id)
            payload["position_snapshot_as_of"] = snapshot.as_of.isoformat()
        else:
            payload["position_snapshot_skipped"] = (
                "paper_account_label_or_mode_guard_failed"
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
