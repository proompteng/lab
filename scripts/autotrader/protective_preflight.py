#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

from synthesis_autotrader_client import SynthesisClient


DEFAULT_ALPACA_BASE_URL = "https://paper-api.alpaca.markets"
TERMINAL_ORDER_STATUSES = {"filled", "canceled", "expired", "rejected"}
CANCEL_VERIFIED_STATUSES = {"canceled", "expired", "rejected"}
OPEN_ORDER_STATUSES = {
    "new",
    "accepted",
    "pending_new",
    "accepted_for_bidding",
    "partially_filled",
    "pending_cancel",
    "pending_replace",
}
PAPER_ALPACA_HOST = "paper-api.alpaca.markets"


class AlpacaClient:
    def __init__(self, *, base_url: str | None = None, timeout_seconds: float = 10.0):
        self.base_url = (base_url or os.environ.get("APCA_API_BASE_URL") or DEFAULT_ALPACA_BASE_URL).rstrip("/")
        self.key_id = os.environ.get("APCA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY_ID") or os.environ.get("ALPACA_API_KEY")
        self.secret_key = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_SECRET_KEY")
        self.timeout_seconds = timeout_seconds
        if not self.key_id or not self.secret_key:
            raise RuntimeError("Alpaca credentials are required for live protective preflight")

    def get(self, path: str) -> Any:
        return self._request("GET", path)

    def patch(self, path: str, payload: dict[str, Any]) -> Any:
        return self._request("PATCH", path, payload)

    def post(self, path: str, payload: dict[str, Any]) -> Any:
        return self._request("POST", path, payload)

    def delete(self, path: str) -> Any:
        return self._request("DELETE", path)

    def get_order_by_id(self, order_id: str) -> dict[str, Any] | None:
        return self._optional_get(f"/v2/orders/{urllib.parse.quote(order_id)}?nested=true")

    def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        query = urllib.parse.urlencode({"client_order_id": client_order_id})
        return self._optional_get(f"/v2/orders:by_client_order_id?{query}")

    def list_open_orders(self, symbol: str) -> list[dict[str, Any]]:
        query = urllib.parse.urlencode({"status": "open", "nested": "true", "symbols": symbol.upper()})
        payload = self.get(f"/v2/orders?{query}")
        return [entry for entry in payload if isinstance(entry, dict)] if isinstance(payload, list) else []

    def get_open_position(self, symbol: str) -> dict[str, Any] | None:
        return self._optional_get(f"/v2/positions/{urllib.parse.quote(symbol.upper())}")

    def _optional_get(self, path: str) -> dict[str, Any] | None:
        try:
            payload = self.get(path)
        except RuntimeError as error:
            if "Alpaca HTTP 404" in str(error):
                return None
            raise
        return payload if isinstance(payload, dict) else None

    def _request(self, method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=data,
            method=method,
            headers={
                "accept": "application/json",
                "content-type": "application/json",
                "APCA-API-KEY-ID": self.key_id,
                "APCA-API-SECRET-KEY": self.secret_key,
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {"ok": True, "status": response.status}
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Alpaca HTTP {error.code} for {method} {path}: {body}") from error


def build_bracket_payload(args: argparse.Namespace) -> dict[str, Any]:
    payload = {
        "symbol": args.symbol.upper(),
        "qty": str(args.qty),
        "side": args.side,
        "type": "limit",
        "time_in_force": args.time_in_force,
        "limit_price": str(args.limit_price),
        "order_class": "bracket",
        "client_order_id": args.client_order_id,
        "take_profit": {"limit_price": str(args.take_profit_limit_price)},
        "stop_loss": {"stop_price": str(args.stop_loss_stop_price)},
    }
    if args.stop_loss_limit_price:
        payload["stop_loss"]["limit_price"] = str(args.stop_loss_limit_price)
    return payload


def validate_bracket_payload(payload: dict[str, Any]) -> None:
    required = ("symbol", "qty", "side", "type", "time_in_force", "limit_price", "order_class", "client_order_id")
    missing = [field for field in required if not payload.get(field)]
    if missing:
        raise ValueError(f"missing required bracket fields: {', '.join(missing)}")
    if len(str(payload["client_order_id"])) > 128:
        raise ValueError("Alpaca client_order_id must be 128 characters or less")
    if payload["order_class"] != "bracket":
        raise ValueError("protective preflight only accepts bracket order_class")
    if payload["type"] != "limit":
        raise ValueError("protective preflight smoke must be a non-marketable limit order")
    take_profit = payload.get("take_profit")
    stop_loss = payload.get("stop_loss")
    if not isinstance(take_profit, dict) or not take_profit.get("limit_price"):
        raise ValueError("take_profit.limit_price is required")
    if "take_profit_limit_price" in payload or "stop_loss_stop_price" in payload:
        raise ValueError("Alpaca REST smoke payload must use nested take_profit/stop_loss objects")
    if not isinstance(stop_loss, dict) or not stop_loss.get("stop_price"):
        raise ValueError("stop_loss.stop_price is required")
    side = str(payload["side"])
    entry = float(payload["limit_price"])
    target = float(take_profit["limit_price"])
    stop = float(stop_loss["stop_price"])
    if side == "buy" and not (target > entry > stop):
        raise ValueError("buy bracket requires take-profit > entry limit > stop-loss stop")
    if side == "sell" and not (target < entry < stop):
        raise ValueError("sell bracket requires take-profit < entry limit < stop-loss stop")


def assert_paper_base_url(base_url: str) -> None:
    hostname = (urllib.parse.urlparse(base_url).hostname or "").lower()
    if hostname != PAPER_ALPACA_HOST:
        raise RuntimeError(f"protective preflight requires Alpaca paper API host {PAPER_ALPACA_HOST}; got {hostname}")


def record_order(
    synthesis: SynthesisClient | None,
    *,
    session_id: str | None,
    status: str,
    payload: dict[str, Any],
    broker_order: dict[str, Any] | None = None,
    reject_reason: str | None = None,
) -> None:
    if not synthesis or not session_id:
        return
    synthesis.post(
        "/api/autotrader/orders",
        {
            "sessionId": session_id,
            "clientOrderId": payload["client_order_id"],
            "brokerOrderId": broker_order.get("id") if broker_order else None,
            "symbol": payload["symbol"],
            "instrument": "stock",
            "side": payload["side"],
            "quantity": payload["qty"],
            "orderType": payload["type"],
            "orderClass": payload["order_class"],
            "limitPrice": payload["limit_price"],
            "takeProfitLimitPrice": payload["take_profit"]["limit_price"],
            "stopLossStopPrice": payload["stop_loss"]["stop_price"],
            "stopLossLimitPrice": payload["stop_loss"].get("limit_price"),
            "status": status,
            "rejectReason": reject_reason,
            "brokerPayload": broker_order or {"request": payload},
        },
    )


def alpaca_order_status(order: dict[str, Any] | None) -> str | None:
    status = order.get("status") if order else None
    return str(status).lower() if status else None


def synthesis_order_status(order: dict[str, Any] | None) -> str:
    status = alpaca_order_status(order)
    if status in {"new", "accepted", "accepted_for_bidding", "pending_new"}:
        return "accepted"
    if status in {"partially_filled", "filled", "canceled", "rejected", "expired", "replaced"}:
        return status
    return "reconciled"


def order_is_open(order: dict[str, Any] | None) -> bool:
    return alpaca_order_status(order) in OPEN_ORDER_STATUSES


def order_filled_quantity(order: dict[str, Any] | None) -> float:
    if not order:
        return 0.0
    value = order.get("filled_qty") or order.get("filled_quantity") or "0"
    try:
        return float(str(value))
    except ValueError:
        return 0.0


def flatten_orders(orders: list[dict[str, Any]]) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    for order in orders:
        flattened.append(order)
        legs = order.get("legs")
        if isinstance(legs, list):
            flattened.extend(entry for entry in legs if isinstance(entry, dict))
    return flattened


def protective_leg_count(order: dict[str, Any] | None) -> int:
    legs = order.get("legs") if order else None
    return len([entry for entry in legs if isinstance(entry, dict)]) if isinstance(legs, list) else 0


def smoke_order_ids(order: dict[str, Any] | None) -> set[str]:
    if not order:
        return set()
    ids = {str(value) for value in (order.get("id"), order.get("client_order_id")) if value}
    for leg in flatten_orders([order]):
        ids.update(str(value) for value in (leg.get("id"), leg.get("client_order_id")) if value)
    return ids


def order_belongs_to_smoke(order: dict[str, Any], payload: dict[str, Any], broker_order: dict[str, Any] | None) -> bool:
    ids = smoke_order_ids(broker_order)
    client_order_id = str(order.get("client_order_id") or "")
    parent_order_id = str(order.get("parent_order_id") or "")
    return (
        client_order_id == str(payload["client_order_id"])
        or bool(parent_order_id and parent_order_id in ids)
        or str(order.get("id") or "") in ids
    )


def position_quantity(position: dict[str, Any] | None) -> float:
    if not position:
        return 0.0
    value = position.get("qty") or position.get("quantity") or "0"
    try:
        return float(str(value))
    except ValueError:
        return 0.0


def reconcile_order(
    alpaca: AlpacaClient,
    payload: dict[str, Any],
    broker_order: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    order_id = broker_order.get("id") if broker_order else None
    if order_id:
        by_id = alpaca.get_order_by_id(str(order_id))
        if by_id:
            return by_id
    return alpaca.get_order_by_client_order_id(str(payload["client_order_id"]))


def wait_for_reconciled_order(
    alpaca: AlpacaClient,
    payload: dict[str, Any],
    broker_order: dict[str, Any],
    *,
    terminal_statuses: set[str],
    timeout_seconds: float,
    poll_seconds: float,
) -> dict[str, Any] | None:
    latest = reconcile_order(alpaca, payload, broker_order)
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while latest and alpaca_order_status(latest) not in terminal_statuses and order_is_open(latest):
        if time.monotonic() >= deadline:
            return latest
        if poll_seconds > 0:
            time.sleep(min(poll_seconds, max(0.0, deadline - time.monotonic())))
        latest = reconcile_order(alpaca, payload, latest)
    return latest


def cancel_and_reconcile_order(
    alpaca: AlpacaClient,
    payload: dict[str, Any],
    broker_order: dict[str, Any],
    *,
    delay_seconds: float,
    timeout_seconds: float,
    poll_seconds: float,
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    if not order_is_open(broker_order):
        return None, broker_order
    order_id = broker_order.get("id")
    if not order_id:
        return None, reconcile_order(alpaca, payload, broker_order)
    cancel_result = alpaca.delete(f"/v2/orders/{urllib.parse.quote(str(order_id))}")
    if delay_seconds > 0:
        time.sleep(delay_seconds)
    return (
        cancel_result,
        wait_for_reconciled_order(
            alpaca,
            payload,
            broker_order,
            terminal_statuses=TERMINAL_ORDER_STATUSES,
            timeout_seconds=timeout_seconds,
            poll_seconds=poll_seconds,
        ),
    )


def append_event(
    synthesis: SynthesisClient | None,
    *,
    session_id: str | None,
    seq: int,
    event_type: str,
    severity: str = "info",
    payload: dict[str, Any],
) -> None:
    if not synthesis or not session_id:
        return
    synthesis.post(
        "/api/autotrader/events",
        {
            "sessionId": session_id,
            "seq": seq,
            "eventType": event_type,
            "severity": severity,
            "payload": payload,
        },
    )


def run_preflight(args: argparse.Namespace) -> dict[str, Any]:
    payload = build_bracket_payload(args)
    validate_bracket_payload(payload)
    base_url = (args.alpaca_base_url or os.environ.get("APCA_API_BASE_URL") or DEFAULT_ALPACA_BASE_URL).rstrip("/")
    if args.submit_smoke:
        assert_paper_base_url(base_url)
    report: dict[str, Any] = {
        "ok": False,
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "alpacaBaseUrl": base_url,
        "paperRoutingVerified": urllib.parse.urlparse(base_url).hostname == PAPER_ALPACA_HOST,
        "payload": payload,
        "submitted": False,
        "canceled": False,
    }
    synthesis = SynthesisClient(base_url=args.synthesis_base_url) if args.synthesis_session_id else None
    append_event(
        synthesis,
        session_id=args.synthesis_session_id,
        seq=args.event_seq_base,
        event_type="protective_preflight_started",
        payload={"clientOrderId": payload["client_order_id"], "symbol": payload["symbol"]},
    )
    if not args.submit_smoke:
        report["ok"] = True
        report["mode"] = "payload_validation_only"
        return report

    alpaca = AlpacaClient(base_url=args.alpaca_base_url, timeout_seconds=args.timeout_seconds)
    config_before = alpaca.get("/v2/account/configurations")
    report["accountConfigurationBefore"] = config_before
    if args.ensure_dtbp_entry and config_before.get("dtbp_check") != "entry":
        report["accountConfigurationAfter"] = alpaca.patch("/v2/account/configurations", {"dtbp_check": "entry"})
    else:
        report["accountConfigurationAfter"] = config_before
    record_order(synthesis, session_id=args.synthesis_session_id, status="planned", payload=payload)
    broker_order: dict[str, Any] | None = None
    try:
        broker_order = alpaca.post("/v2/orders", payload)
        report["submitted"] = True
        report["brokerOrder"] = broker_order
        record_order(synthesis, session_id=args.synthesis_session_id, status="submitted", payload=payload, broker_order=broker_order)
        reconciled_order = reconcile_order(alpaca, payload, broker_order)
        report["reconciledOrder"] = reconciled_order
        record_order(
            synthesis,
            session_id=args.synthesis_session_id,
            status=synthesis_order_status(reconciled_order or broker_order),
            payload=payload,
            broker_order=reconciled_order or broker_order,
        )
        cancel_result, final_order = cancel_and_reconcile_order(
            alpaca,
            payload,
            reconciled_order or broker_order,
            delay_seconds=args.cancel_reconcile_delay_seconds,
            timeout_seconds=args.cancel_reconcile_timeout_seconds,
            poll_seconds=args.cancel_reconcile_poll_seconds,
        )
        report["cancelResult"] = cancel_result
        report["finalOrder"] = final_order
        final_status = alpaca_order_status(final_order)
        report["filledQty"] = order_filled_quantity(final_order)
        report["protectiveLegCount"] = max(protective_leg_count(reconciled_order), protective_leg_count(final_order))
        open_orders = alpaca.list_open_orders(payload["symbol"])
        smoke_open_orders = [
            order for order in flatten_orders(open_orders) if order_belongs_to_smoke(order, payload, final_order or broker_order)
        ]
        position = alpaca.get_open_position(payload["symbol"])
        report["openOrdersAfterCancel"] = len(open_orders)
        report["smokeOpenOrdersAfterCancel"] = len(smoke_open_orders)
        report["positionAfterCancel"] = position
        report["positionQtyAfterCancel"] = position_quantity(position)
        report["canceled"] = final_status == "canceled"
        report["cancelVerified"] = final_status in CANCEL_VERIFIED_STATUSES
        report["terminalOrderStatus"] = final_status
        report["zeroFillVerified"] = report["filledQty"] == 0
        report["noSmokeOpenOrdersVerified"] = not smoke_open_orders
        report["noPositionVerified"] = report["positionQtyAfterCancel"] == 0
        report["childLegsVerified"] = report["protectiveLegCount"] >= 2
        report["unmanagedExposurePossible"] = not (
            report["cancelVerified"]
            and report["zeroFillVerified"]
            and report["noSmokeOpenOrdersVerified"]
            and report["noPositionVerified"]
        )
        record_order(
            synthesis,
            session_id=args.synthesis_session_id,
            status=synthesis_order_status(final_order),
            payload=payload,
            broker_order=final_order or reconciled_order or broker_order,
        )
        report["ok"] = bool(
            report["submitted"]
            and report["paperRoutingVerified"]
            and report["cancelVerified"]
            and report["zeroFillVerified"]
            and report["noSmokeOpenOrdersVerified"]
            and report["noPositionVerified"]
            and report["childLegsVerified"]
            and not report["unmanagedExposurePossible"]
        )
        append_event(
            synthesis,
            session_id=args.synthesis_session_id,
            seq=args.event_seq_base + 1,
            event_type="protective_preflight_complete",
            payload={
                "clientOrderId": payload["client_order_id"],
                "submitted": report["submitted"],
                "canceled": report["canceled"],
                "cancelVerified": report["cancelVerified"],
                "filledQty": report["filledQty"],
                "openOrdersAfterCancel": report["openOrdersAfterCancel"],
                "smokeOpenOrdersAfterCancel": report["smokeOpenOrdersAfterCancel"],
                "positionQtyAfterCancel": report["positionQtyAfterCancel"],
                "protectiveLegCount": report["protectiveLegCount"],
                "terminalOrderStatus": report["terminalOrderStatus"],
                "unmanagedExposurePossible": report["unmanagedExposurePossible"],
            },
        )
    except Exception as error:
        report["error"] = str(error)
        try:
            reconciled_after_error = reconcile_order(alpaca, payload, broker_order)
            report["reconciledAfterError"] = reconciled_after_error
            report["submitted"] = bool(report["submitted"] or reconciled_after_error)
            if reconciled_after_error and order_is_open(reconciled_after_error):
                cancel_result, final_order = cancel_and_reconcile_order(
                    alpaca,
                    payload,
                    reconciled_after_error,
                    delay_seconds=args.cancel_reconcile_delay_seconds,
                    timeout_seconds=args.cancel_reconcile_timeout_seconds,
                    poll_seconds=args.cancel_reconcile_poll_seconds,
                )
                report["cancelResultAfterError"] = cancel_result
                report["finalOrderAfterError"] = final_order
                report["terminalOrderStatus"] = alpaca_order_status(final_order)
                report["canceled"] = report["terminalOrderStatus"] == "canceled"
                report["cancelVerified"] = report["terminalOrderStatus"] in CANCEL_VERIFIED_STATUSES
                report["filledQty"] = order_filled_quantity(final_order)
                report["protectiveLegCount"] = max(
                    protective_leg_count(reconciled_after_error),
                    protective_leg_count(final_order),
                )
                open_orders = alpaca.list_open_orders(payload["symbol"])
                smoke_open_orders = [
                    order
                    for order in flatten_orders(open_orders)
                    if order_belongs_to_smoke(order, payload, final_order or reconciled_after_error)
                ]
                position = alpaca.get_open_position(payload["symbol"])
                report["openOrdersAfterCancel"] = len(open_orders)
                report["smokeOpenOrdersAfterCancel"] = len(smoke_open_orders)
                report["positionAfterCancel"] = position
                report["positionQtyAfterCancel"] = position_quantity(position)
                report["zeroFillVerified"] = report["filledQty"] == 0
                report["noSmokeOpenOrdersVerified"] = not smoke_open_orders
                report["noPositionVerified"] = report["positionQtyAfterCancel"] == 0
                report["childLegsVerified"] = report["protectiveLegCount"] >= 2
                report["unmanagedExposurePossible"] = not (
                    report["cancelVerified"]
                    and report["zeroFillVerified"]
                    and report["noSmokeOpenOrdersVerified"]
                    and report["noPositionVerified"]
                )
                record_order(
                    synthesis,
                    session_id=args.synthesis_session_id,
                    status=synthesis_order_status(final_order),
                    payload=payload,
                    broker_order=final_order or reconciled_after_error,
                )
            elif reconciled_after_error:
                report["terminalOrderStatus"] = alpaca_order_status(reconciled_after_error)
                report["cancelVerified"] = report["terminalOrderStatus"] in CANCEL_VERIFIED_STATUSES
                report["unmanagedExposurePossible"] = report["terminalOrderStatus"] not in CANCEL_VERIFIED_STATUSES
                record_order(
                    synthesis,
                    session_id=args.synthesis_session_id,
                    status=synthesis_order_status(reconciled_after_error),
                    payload=payload,
                    broker_order=reconciled_after_error,
                    reject_reason=str(error) if alpaca_order_status(reconciled_after_error) == "rejected" else None,
                )
            else:
                report["unmanagedExposurePossible"] = report["submitted"]
                record_order(synthesis, session_id=args.synthesis_session_id, status="rejected", payload=payload, reject_reason=str(error))
        except Exception as reconcile_error:
            report["reconcileAfterError"] = str(reconcile_error)
            report["unmanagedExposurePossible"] = report["submitted"]
        append_event(
            synthesis,
            session_id=args.synthesis_session_id,
            seq=args.event_seq_base + 1,
            event_type="protective_preflight_failed",
            severity="error",
            payload={
                "clientOrderId": payload["client_order_id"],
                "error": str(error),
                "cancelVerified": report.get("cancelVerified"),
                "terminalOrderStatus": report.get("terminalOrderStatus"),
                "unmanagedExposurePossible": report.get("unmanagedExposurePossible"),
            },
        )
    return report


def write_report(report: dict[str, Any], output: str | None) -> None:
    text = json.dumps(report, indent=2, sort_keys=True)
    if output:
        Path(output).parent.mkdir(parents=True, exist_ok=True)
        Path(output).write_text(f"{text}\n", encoding="utf-8")
    else:
        print(text)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate and optionally prove Alpaca bracket protective-order path.")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--symbol", default="SPY")
    parser.add_argument("--qty", default="1")
    parser.add_argument("--side", choices=["buy", "sell"], default="buy")
    parser.add_argument("--time-in-force", default="day")
    parser.add_argument("--limit-price", default="100")
    parser.add_argument("--take-profit-limit-price", default="101")
    parser.add_argument("--stop-loss-stop-price", default="99")
    parser.add_argument("--stop-loss-limit-price", default="98.99")
    parser.add_argument("--client-order-id", default="autotrader-protective-preflight-self-test")
    parser.add_argument("--submit-smoke", action="store_true")
    parser.add_argument("--ensure-dtbp-entry", action="store_true")
    parser.add_argument("--alpaca-base-url")
    parser.add_argument("--synthesis-base-url")
    parser.add_argument("--synthesis-session-id")
    parser.add_argument("--event-seq-base", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--cancel-reconcile-delay-seconds", type=float, default=0.5)
    parser.add_argument("--cancel-reconcile-timeout-seconds", type=float, default=5.0)
    parser.add_argument("--cancel-reconcile-poll-seconds", type=float, default=0.25)
    parser.add_argument("--output")
    return parser


def build_self_test_report(args: argparse.Namespace) -> dict[str, Any]:
    payload = build_bracket_payload(args)
    validate_bracket_payload(payload)

    class FakeAlpaca:
        def __init__(self) -> None:
            self.deleted: list[str] = []
            self.reads = 0

        def delete(self, path: str) -> dict[str, Any]:
            self.deleted.append(path)
            return {"ok": True, "status": 204}

        def get_order_by_id(self, order_id: str) -> dict[str, Any]:
            self.reads += 1
            status = "pending_cancel" if self.reads == 1 else "canceled"
            return {"id": order_id, "client_order_id": payload["client_order_id"], "status": status}

        def get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any]:
            return {"id": "fake-order-1", "client_order_id": client_order_id, "status": "canceled"}

    fake_alpaca = FakeAlpaca()
    _, final_order = cancel_and_reconcile_order(
        fake_alpaca,  # type: ignore[arg-type]
        payload,
        {"id": "fake-order-1", "status": "new"},
        delay_seconds=0,
        timeout_seconds=0.05,
        poll_seconds=0.001,
    )
    if alpaca_order_status(final_order) != "canceled":
        raise AssertionError("self-test fake order did not reconcile to canceled")
    if not fake_alpaca.deleted:
        raise AssertionError("self-test fake order was not canceled")
    return {
        "ok": True,
        "payload": payload,
        "synthesisStatusNew": synthesis_order_status({"status": "new"}),
        "synthesisStatusCanceled": synthesis_order_status({"status": "canceled"}),
        "reconcileReads": fake_alpaca.reads,
        "cancelVerified": alpaca_order_status(final_order) in CANCEL_VERIFIED_STATUSES,
    }


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        write_report(build_self_test_report(args), args.output)
        return 0
    report = run_preflight(args)
    write_report(report, args.output)
    if report.get("ok"):
        return 0
    print(report.get("error") or "protective preflight did not prove cancel/reconcile safety", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
