#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from synthesis_autotrader_client import SynthesisClient


DEFAULT_ALPACA_BASE_URL = "https://paper-api.alpaca.markets"


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
    report: dict[str, Any] = {
        "ok": False,
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "alpacaBaseUrl": args.alpaca_base_url or os.environ.get("APCA_API_BASE_URL") or DEFAULT_ALPACA_BASE_URL,
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
    try:
        broker_order = alpaca.post("/v2/orders", payload)
        report["submitted"] = True
        report["brokerOrder"] = broker_order
        record_order(synthesis, session_id=args.synthesis_session_id, status="submitted", payload=payload, broker_order=broker_order)
        order_id = broker_order.get("id")
        if order_id:
            cancel_result = alpaca.delete(f"/v2/orders/{order_id}")
            report["canceled"] = True
            report["cancelResult"] = cancel_result
            record_order(synthesis, session_id=args.synthesis_session_id, status="canceled", payload=payload, broker_order=broker_order)
        report["ok"] = report["submitted"] and report["canceled"]
        append_event(
            synthesis,
            session_id=args.synthesis_session_id,
            seq=args.event_seq_base + 1,
            event_type="protective_preflight_complete",
            payload={"clientOrderId": payload["client_order_id"], "submitted": report["submitted"], "canceled": report["canceled"]},
        )
    except Exception as error:
        report["error"] = str(error)
        record_order(synthesis, session_id=args.synthesis_session_id, status="rejected", payload=payload, reject_reason=str(error))
        append_event(
            synthesis,
            session_id=args.synthesis_session_id,
            seq=args.event_seq_base + 1,
            event_type="protective_preflight_failed",
            severity="error",
            payload={"clientOrderId": payload["client_order_id"], "error": str(error)},
        )
        raise
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
    parser.add_argument("--output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        payload = build_bracket_payload(args)
        validate_bracket_payload(payload)
        write_report({"ok": True, "payload": payload}, args.output)
        return 0
    try:
        write_report(run_preflight(args), args.output)
        return 0
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
