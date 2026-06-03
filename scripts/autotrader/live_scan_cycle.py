#!/usr/bin/env python3
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation, ROUND_FLOOR
from pathlib import Path
from typing import Any, Callable
from zoneinfo import ZoneInfo

from protective_preflight import assert_paper_base_url, normalize_alpaca_base_url
from synthesis_autotrader_client import SynthesisClient


DEFAULT_DATA_BASE_URL = "https://data.alpaca.markets/v2"
DEFAULT_WATCHLIST = ("SPY", "QQQ", "NVDA", "AVGO", "TSLA", "AAPL", "MSFT", "AMD", "PLTR", "GOOGL")
MARKET_TIMEZONE = ZoneInfo("America/New_York")
SYNTHESIS_INSTRUMENTS = {"stock", "etf", "option", "crypto", "other"}
SYNTHESIS_SIDES = {
    "buy",
    "sell",
    "sell_short",
    "buy_to_cover",
    "buy_to_open",
    "buy_to_close",
    "sell_to_open",
    "sell_to_close",
}
ACTIONABLE_SETUP_GRADES = {"A+", "A", "B"}
MIN_ACTIONABLE_EXPECTED_R = Decimal("2.0")
MIN_ACTIONABLE_BRACKET_R = Decimal("2.0")
MIN_SCORECARD_RISK_SCALE_SAMPLE_SIZE = 2
MIN_SCORECARD_ACTIONABLE_AVG_REALIZED_R = Decimal("0.5")
MIN_POST_LOSS_EXPECTED_R = Decimal("3.0")
MIN_POST_LOSS_BRACKET_R = Decimal("3.0")
MIN_POST_LOSS_SCORECARD_AVG_REALIZED_R = Decimal("1.0")
MAX_SCORECARD_RISK_MULTIPLIER = Decimal("2.0")
MAX_CURRENT_SESSION_LOSING_ROUND_TRIPS = 2
BASE_RISK_EQUITY_PCT = Decimal("0.0025")
MAX_RISK_EQUITY_PCT = Decimal("0.005")
MAX_POSITION_NOTIONAL_EQUITY_PCT = Decimal("0.50")
MAX_INTRADAY_EQUITY_DRAWDOWN_PCT = Decimal("0.015")
ACCOUNT_MONEY_QUANT = Decimal("0.01")
ACCOUNT_RATIO_QUANT = Decimal("0.000001")
R_MULTIPLE_QUANT = Decimal("0.000001")
PROFIT_PROTECT_BREAKEVEN_TRIGGER_R = Decimal("0.5")
PROFIT_PROTECT_LOCK_TRIGGER_R = Decimal("1.0")
PROFIT_LOCK_R = Decimal("0.25")


class AlpacaRestClient:
    def __init__(
        self,
        *,
        trading_base_url: str | None = None,
        data_base_url: str | None = None,
        timeout_seconds: float = 10.0,
    ):
        self.trading_base_url = normalize_alpaca_base_url(
            trading_base_url or os.environ.get("APCA_API_BASE_URL") or "https://paper-api.alpaca.markets"
        )
        assert_paper_base_url(self.trading_base_url)
        self.data_base_url = normalize_alpaca_data_base_url(
            data_base_url or os.environ.get("ALPACA_DATA_BASE_URL") or DEFAULT_DATA_BASE_URL
        )
        self.key_id = (
            os.environ.get("APCA_API_KEY_ID")
            or os.environ.get("ALPACA_API_KEY_ID")
            or os.environ.get("ALPACA_API_KEY")
        )
        self.secret_key = os.environ.get("APCA_API_SECRET_KEY") or os.environ.get("ALPACA_SECRET_KEY")
        self.timeout_seconds = timeout_seconds
        if not self.key_id or not self.secret_key:
            raise RuntimeError("Alpaca credentials are required for live scan cycle")

    def trading_get(self, path: str, query: dict[str, str] | None = None) -> Any:
        return self._request(self.trading_base_url, path, query)

    def data_get(self, path: str, query: dict[str, str]) -> Any:
        return self._request(self.data_base_url, path, query)

    def _request(self, base_url: str, path: str, query: dict[str, str] | None = None) -> Any:
        url = f"{base_url}{path}"
        if query:
            url = f"{url}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(
            url,
            headers={
                "accept": "application/json",
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
            raise RuntimeError(f"Alpaca HTTP {error.code} for GET {url}: {body}") from error


def normalize_alpaca_data_base_url(base_url: str) -> str:
    trimmed = base_url.rstrip("/")
    parsed = urllib.parse.urlparse(trimmed)
    path = parsed.path.rstrip("/")
    if path.endswith("/v2"):
        next_path = path
    else:
        next_path = f"{path}/v2" if path else "/v2"
    if not parsed.scheme or not parsed.netloc:
        return trimmed
    return urllib.parse.urlunparse(parsed._replace(path=next_path, params="", query="", fragment="")).rstrip("/")


def normalize_watchlist(values: list[str]) -> list[str]:
    symbols = values or list(DEFAULT_WATCHLIST)
    normalized: list[str] = []
    seen: set[str] = set()
    for value in symbols:
        symbol = value.strip().upper()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        normalized.append(symbol)
    if not normalized:
        raise ValueError("watchlist cannot be empty")
    return normalized


def next_cycle_number(work_dir: Path) -> int:
    max_cycle = 0
    pattern = re.compile(r"^cycle-(\d+)$")
    for path in work_dir.glob("cycle-*"):
        match = pattern.match(path.name)
        if match:
            max_cycle = max(max_cycle, int(match.group(1)))
    return max_cycle + 1


def prune_old_cycle_dirs(work_dir: Path, retain_cycles: int) -> list[str]:
    if retain_cycles < 1:
        return []
    cycles: list[tuple[int, Path]] = []
    pattern = re.compile(r"^cycle-(\d+)$")
    for path in work_dir.glob("cycle-*"):
        if not path.is_dir():
            continue
        match = pattern.match(path.name)
        if match:
            cycles.append((int(match.group(1)), path))
    cycles.sort(key=lambda item: item[0])
    stale_cycles = cycles[: max(0, len(cycles) - retain_cycles)]
    removed: list[str] = []
    for _, path in stale_cycles:
        shutil.rmtree(path)
        removed.append(path.name)
    return removed


def account_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    return bool(value)


def parse_account_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def parse_account_int(value: Any) -> int | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        return None


def quantized_decimal_text(value: Decimal, quantum: Decimal) -> str:
    return str(value.quantize(quantum))


def normalized_quantized_decimal_text(value: Decimal, quantum: Decimal) -> str:
    return format(value.quantize(quantum).normalize(), "f")


def floored_decimal_int_text(value: Decimal) -> str | None:
    if value <= 0:
        return None
    quantity = value.to_integral_value(rounding=ROUND_FLOOR)
    return str(quantity) if quantity > 0 else None


def intraday_equity_entry_eligibility(account: dict[str, Any]) -> dict[str, Any]:
    daytrading_buying_power = account.get("daytrading_buying_power") or account.get("daytrade_buying_power")
    daytrading_buying_power_value = parse_account_decimal(daytrading_buying_power)
    daytrade_count = parse_account_int(account.get("daytrade_count"))
    equity = parse_account_decimal(account.get("equity"))
    last_equity = parse_account_decimal(account.get("last_equity") or account.get("lastEquity"))
    reasons: list[str] = []
    details: dict[str, str] = {}

    if account_bool(account.get("account_blocked", False)) or account_bool(account.get("trading_blocked", False)):
        reasons.append("account_or_trading_blocked")
    if daytrading_buying_power_value is not None and daytrading_buying_power_value <= 0:
        reasons.append("daytrading_buying_power_not_positive")
    if (
        daytrade_count is not None
        and daytrade_count >= 4
        and daytrading_buying_power_value is not None
        and daytrading_buying_power_value <= 0
    ):
        reasons.append("pdt_daytrade_count_at_or_above_four_without_dtbp")

    if equity is not None and last_equity is not None and last_equity > 0:
        drawdown_amount = max(last_equity - equity, Decimal("0"))
        drawdown_pct = drawdown_amount / last_equity
        details = {
            "intradayEquityDrawdownBasis": "equity_vs_last_equity",
            "intradayEquityDrawdownAmount": quantized_decimal_text(drawdown_amount, ACCOUNT_MONEY_QUANT),
            "intradayEquityDrawdownPct": quantized_decimal_text(drawdown_pct, ACCOUNT_RATIO_QUANT),
            "intradayEquityDrawdownLimitPct": quantized_decimal_text(
                MAX_INTRADAY_EQUITY_DRAWDOWN_PCT, ACCOUNT_RATIO_QUANT
            ),
        }
        if drawdown_pct >= MAX_INTRADAY_EQUITY_DRAWDOWN_PCT:
            reasons.append("intraday_equity_drawdown_limit_exceeded")

    return {
        "status": "blocked" if reasons else "allowed",
        "reasons": reasons,
        **details,
    }


def format_account(account: dict[str, Any]) -> dict[str, Any]:
    daytrading_buying_power = account.get("daytrading_buying_power") or account.get("daytrade_buying_power")
    formatted_account = {
        "account": {
            "id": account.get("id"),
            "equity": account.get("equity"),
            "cash": account.get("cash"),
            "buying_power": account.get("buying_power"),
            "daytrading_buying_power": daytrading_buying_power,
            "daytrade_count": account.get("daytrade_count"),
            "pattern_day_trader": account_bool(account.get("pattern_day_trader", False)),
            "trading_blocked": account_bool(account.get("trading_blocked", False)),
            "account_blocked": account_bool(account.get("account_blocked", False)),
            "intraday_equity_entry": intraday_equity_entry_eligibility(account),
        }
    }
    last_equity = account.get("last_equity") or account.get("lastEquity")
    if last_equity is not None:
        formatted_account["account"]["last_equity"] = last_equity
    return formatted_account


def list_payload(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def summarized_position(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"raw": value}
    return {
        "symbol": value.get("symbol"),
        "assetClass": value.get("asset_class") or value.get("assetClass"),
        "side": value.get("side"),
        "qty": numeric_text(value.get("qty")),
        "marketValue": numeric_text(value.get("market_value") or value.get("marketValue")),
        "avgEntryPrice": numeric_text(value.get("avg_entry_price") or value.get("avgEntryPrice")),
        "currentPrice": numeric_text(value.get("current_price") or value.get("currentPrice")),
        "unrealizedPnl": numeric_text(value.get("unrealized_pl") or value.get("unrealizedPnl")),
    }


def summarized_order(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"raw": value}
    legs = value.get("legs")
    return {
        "id": value.get("id"),
        "clientOrderId": value.get("client_order_id") or value.get("clientOrderId"),
        "symbol": value.get("symbol"),
        "side": value.get("side"),
        "qty": numeric_text(value.get("qty")),
        "filledQty": numeric_text(value.get("filled_qty") or value.get("filledQty")),
        "type": value.get("type"),
        "orderClass": value.get("order_class") or value.get("orderClass"),
        "status": value.get("status"),
        "limitPrice": numeric_text(value.get("limit_price") or value.get("limitPrice")),
        "stopPrice": numeric_text(value.get("stop_price") or value.get("stopPrice")),
        "submittedAt": value.get("submitted_at") or value.get("submittedAt"),
        "legCount": len(legs) if isinstance(legs, list) else 0,
    }


def order_children(value: Any) -> list[Any]:
    if not isinstance(value, dict):
        return []
    children: list[Any] = []
    legs = value.get("legs")
    if isinstance(legs, list):
        for leg in legs:
            children.append(leg)
            children.extend(order_children(leg))
    return children


def flat_orders(values: list[Any]) -> list[dict[str, Any]]:
    flattened: list[dict[str, Any]] = []
    for value in values:
        if isinstance(value, dict):
            flattened.append(value)
            flattened.extend(child for child in order_children(value) if isinstance(child, dict))
    return flattened


def position_side(value: dict[str, Any]) -> str:
    side = optional_text(value.get("side"), max_length=32)
    if side in {"long", "short"}:
        return side
    qty = decimal_value(value.get("qty"))
    if qty is not None and qty < 0:
        return "short"
    return "long"


def order_is_active(value: dict[str, Any]) -> bool:
    status = optional_text(value.get("status"), max_length=64)
    return status not in {"filled", "canceled", "expired", "rejected", "replaced"}


def matching_symbol_order(value: dict[str, Any], symbol: str) -> bool:
    order_symbol = optional_text(value.get("symbol"), max_length=32)
    return bool(order_symbol and order_symbol.upper() == symbol.upper())


def stop_price_for_order(value: dict[str, Any]) -> Decimal | None:
    return decimal_value(value.get("stop_price") or value.get("stopPrice"))


def limit_price_for_order(value: dict[str, Any]) -> Decimal | None:
    return decimal_value(value.get("limit_price") or value.get("limitPrice"))


def protective_orders_for_position(position: dict[str, Any], orders: list[Any]) -> dict[str, Any]:
    symbol = optional_text(position.get("symbol"), max_length=32)
    if not symbol:
        return {"hasStop": False, "hasTakeProfit": False}
    side = position_side(position)
    stop_candidates: list[tuple[Decimal, dict[str, Any]]] = []
    target_candidates: list[tuple[Decimal, dict[str, Any]]] = []
    for order in flat_orders(orders):
        if not matching_symbol_order(order, symbol) or not order_is_active(order):
            continue
        order_side = optional_text(order.get("side"), max_length=32)
        if side == "long" and order_side not in {"sell", "sell_to_close"}:
            continue
        if side == "short" and order_side not in {"buy", "buy_to_cover", "buy_to_close"}:
            continue
        stop_price = stop_price_for_order(order)
        limit_price = limit_price_for_order(order)
        if stop_price is not None:
            stop_candidates.append((stop_price, order))
        if limit_price is not None and stop_price is None:
            target_candidates.append((limit_price, order))
    if side == "long":
        stop_candidates.sort(key=lambda item: item[0], reverse=True)
        target_candidates.sort(key=lambda item: item[0])
    else:
        stop_candidates.sort(key=lambda item: item[0])
        target_candidates.sort(key=lambda item: item[0], reverse=True)
    stop = stop_candidates[0] if stop_candidates else None
    target = target_candidates[0] if target_candidates else None
    return {
        "hasStop": stop is not None,
        "hasTakeProfit": target is not None,
        "stopPrice": str(stop[0]) if stop else None,
        "stopOrderId": stop[1].get("id") if stop else None,
        "stopClientOrderId": stop[1].get("client_order_id") or stop[1].get("clientOrderId") if stop else None,
        "takeProfitPrice": str(target[0]) if target else None,
        "takeProfitOrderId": target[1].get("id") if target else None,
        "takeProfitClientOrderId": target[1].get("client_order_id") or target[1].get("clientOrderId") if target else None,
    }


def rounded_price(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01")))


def position_management_for_position(position: dict[str, Any], orders: list[Any]) -> dict[str, Any]:
    symbol = optional_text(position.get("symbol"), max_length=32) or "UNKNOWN"
    side = position_side(position)
    entry = decimal_value(position.get("avg_entry_price") or position.get("avgEntryPrice"))
    current = decimal_value(position.get("current_price") or position.get("currentPrice"))
    qty = decimal_value(position.get("qty"))
    if current is None:
        market_value = decimal_value(position.get("market_value") or position.get("marketValue"))
        if market_value is not None and qty is not None and qty != 0:
            current = abs(market_value / qty)
    protection = protective_orders_for_position(position, orders)
    stop = decimal_value(protection.get("stopPrice"))
    if entry is None or current is None:
        return {
            "symbol": symbol.upper(),
            "side": side,
            "action": "refresh_broker_state",
            "reason": "missing_entry_or_current_price",
            "protection": protection,
        }
    if stop is None:
        return {
            "symbol": symbol.upper(),
            "side": side,
            "action": "repair_or_flatten_unprotected_position",
            "reason": "missing_protective_stop",
            "entryPrice": str(entry),
            "currentPrice": str(current),
            "protection": protection,
        }
    initial_r = abs(entry - stop)
    if initial_r <= 0:
        return {
            "symbol": symbol.upper(),
            "side": side,
            "action": "repair_or_flatten_invalid_stop",
            "reason": "invalid_stop_distance",
            "entryPrice": str(entry),
            "currentPrice": str(current),
            "stopPrice": str(stop),
            "protection": protection,
        }
    if side == "short":
        open_r = (entry - current) / initial_r
        stop_r = (entry - stop) / initial_r
        breakeven_stop = entry
        locked_stop = entry - (initial_r * PROFIT_LOCK_R)
    else:
        open_r = (current - entry) / initial_r
        stop_r = (stop - entry) / initial_r
        breakeven_stop = entry
        locked_stop = entry + (initial_r * PROFIT_LOCK_R)
    action = "hold_existing_protection"
    reason = "protected_position_inside_profit_lock_thresholds"
    recommended_stop: Decimal | None = None
    if open_r >= PROFIT_PROTECT_LOCK_TRIGGER_R and stop_r < PROFIT_LOCK_R:
        action = "tighten_stop_lock_profit"
        reason = "open_profit_at_or_above_1r"
        recommended_stop = locked_stop
    elif open_r >= PROFIT_PROTECT_BREAKEVEN_TRIGGER_R and stop_r < 0:
        action = "tighten_stop_to_breakeven"
        reason = "open_profit_at_or_above_0_5r"
        recommended_stop = breakeven_stop
    return {
        "symbol": symbol.upper(),
        "side": side,
        "action": action,
        "reason": reason,
        "entryPrice": str(entry),
        "currentPrice": str(current),
        "stopPrice": str(stop),
        "openR": str(open_r.quantize(Decimal("0.0001"))),
        "stopR": str(stop_r.quantize(Decimal("0.0001"))),
        "recommendedStopPrice": rounded_price(recommended_stop) if recommended_stop is not None else None,
        "protection": protection,
    }


def position_management_summary(positions: list[Any], orders: list[Any]) -> dict[str, Any]:
    directives = [
        position_management_for_position(position, orders)
        for position in positions
        if isinstance(position, dict)
    ]
    action_priority = {
        "repair_or_flatten_unprotected_position": 5,
        "repair_or_flatten_invalid_stop": 5,
        "tighten_stop_lock_profit": 4,
        "tighten_stop_to_breakeven": 3,
        "refresh_broker_state": 2,
        "hold_existing_protection": 1,
    }
    primary = max(directives, key=lambda item: action_priority.get(str(item.get("action")), 0), default=None)
    return {
        "mode": "serial_position_management",
        "directiveCount": len(directives),
        "actionRequired": bool(primary and action_priority.get(str(primary.get("action")), 0) >= 2),
        "primaryAction": primary.get("action") if isinstance(primary, dict) else None,
        "primaryReason": primary.get("reason") if isinstance(primary, dict) else None,
        "positions": directives,
    }


def summarize_records(values: list[Any], summarize: Callable[[Any], dict[str, Any]], limit: int = 20) -> list[dict[str, Any]]:
    return [summarize(value) for value in values[:limit]]


def account_gate_action(account: dict[str, Any], positions: list[Any], orders: list[Any]) -> str:
    if positions or orders:
        return "manage_existing_broker_state"
    eligibility = account.get("intraday_equity_entry")
    entry_allowed = isinstance(eligibility, dict) and eligibility.get("status") == "allowed"
    if entry_allowed:
        return "scan"
    return "monitor_only"


def summarize_account_gate(
    *,
    raw_account: dict[str, Any],
    raw_positions: Any,
    raw_orders: Any,
) -> dict[str, Any]:
    account = format_account(raw_account)["account"]
    positions = list_payload(raw_positions)
    orders = list_payload(raw_orders)
    action = account_gate_action(account, positions, orders)
    return {
        "ok": True,
        "mode": "account_gate",
        "account": account,
        "openPositionCount": len(positions),
        "openOrderCount": len(orders),
        "openPositions": summarize_records(positions, summarized_position),
        "openOrders": summarize_records(orders, summarized_order),
        "positionManagement": position_management_summary(positions, orders) if positions else None,
        "hasOpenBrokerState": bool(positions or orders),
        "action": action,
        "skipFullScan": action != "scan",
    }


def fetch_broker_state(alpaca: AlpacaRestClient) -> dict[str, Any]:
    state, _ = fetch_broker_state_with_metrics(alpaca)
    return state


def fetch_broker_state_with_metrics(alpaca: AlpacaRestClient) -> tuple[dict[str, Any], dict[str, Any]]:
    started_at = time.monotonic()

    def timed_account() -> tuple[Any, int]:
        task_started_at = time.monotonic()
        payload = alpaca.trading_get("/v2/account")
        return payload, elapsed_ms(task_started_at)

    def timed_positions() -> tuple[Any, int]:
        task_started_at = time.monotonic()
        payload = alpaca.trading_get("/v2/positions")
        return payload, elapsed_ms(task_started_at)

    def timed_orders() -> tuple[Any, int]:
        task_started_at = time.monotonic()
        payload = alpaca.trading_get("/v2/orders", {"status": "open", "nested": "true"})
        return payload, elapsed_ms(task_started_at)

    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            "account": executor.submit(timed_account),
            "positions": executor.submit(timed_positions),
            "orders": executor.submit(timed_orders),
        }
        account, account_ms = futures["account"].result()
        positions, positions_ms = futures["positions"].result()
        orders, orders_ms = futures["orders"].result()

    metrics = {
        "parallelFetchCount": 3,
        "accountMs": account_ms,
        "positionsMs": positions_ms,
        "ordersMs": orders_ms,
        "totalMs": elapsed_ms(started_at),
    }
    return {
        "account": account,
        "positions": positions,
        "orders": orders,
    }, metrics


def summarize_broker_state(raw_broker_state: dict[str, Any]) -> dict[str, Any]:
    account = raw_broker_state.get("account")
    if not isinstance(account, dict):
        raise ValueError("broker account state must be an object")
    return summarize_account_gate(
        raw_account=account,
        raw_positions=raw_broker_state.get("positions"),
        raw_orders=raw_broker_state.get("orders"),
    )


def account_gate_blocker(gate: dict[str, Any]) -> str | None:
    account = gate.get("account")
    eligibility = account.get("intraday_equity_entry") if isinstance(account, dict) else None
    reasons = eligibility.get("reasons") if isinstance(eligibility, dict) else None
    if isinstance(reasons, list) and reasons:
        return ";".join(str(reason) for reason in reasons if str(reason))
    action = optional_text(gate.get("action"))
    if action and action != "scan":
        return action
    return None


def account_gate_status_phase(gate: dict[str, Any]) -> str:
    action = gate.get("action")
    if action == "scan":
        return "scan"
    if action == "manage_existing_broker_state":
        return "manage"
    return "idle"


def account_gate_current_action(gate: dict[str, Any]) -> str:
    action = gate.get("action")
    if action == "scan":
        return "account gate passed; scanning live candidates"
    if action == "manage_existing_broker_state":
        management = gate.get("positionManagement")
        if isinstance(management, dict) and management.get("primaryAction"):
            return f"account gate managing existing broker state; {management.get('primaryAction')}"
        return "account gate managing existing broker state"
    return "account gate blocked new entries; monitoring only"


def record_account_gate(
    *,
    synthesis: SynthesisClient,
    session_id: str,
    cycle: int,
    gate: dict[str, Any],
) -> dict[str, Any]:
    if not session_id.strip():
        raise ValueError("session id is required when recording account gate")
    account = gate.get("account") if isinstance(gate.get("account"), dict) else {}
    blocker = account_gate_blocker(gate)
    risk = synthesis.post(
        "/api/autotrader/risk-checks",
        {
            "sessionId": session_id,
            "idempotencyKey": f"account-gate-cycle-{cycle}",
            "checkType": "intraday_equity_entry",
            "passed": gate.get("action") == "scan",
            "reason": blocker or "account_gate_passed",
            "payload": gate,
        },
    )
    status = synthesis.post(
        "/api/autotrader/status",
        {
            "sessionId": session_id,
            "cycle": cycle,
            "phase": account_gate_status_phase(gate),
            "equity": numeric_text(account.get("equity")),
            "buyingPower": numeric_text(account.get("buying_power")),
            "daytradeBuyingPower": numeric_text(account.get("daytrading_buying_power")),
            "currentAction": account_gate_current_action(gate),
            "blocker": blocker,
            "payload": {"accountGate": gate},
        },
    )
    return {
        "statusId": status.get("status", {}).get("sessionId") if isinstance(status, dict) else None,
        "riskCheckId": risk.get("riskCheck", {}).get("id") if isinstance(risk, dict) else None,
        "blocker": blocker,
    }


def format_latest_quotes(payload: dict[str, Any], symbols: list[str]) -> dict[str, Any]:
    raw_quotes = payload.get("quotes") if isinstance(payload, dict) else None
    if not isinstance(raw_quotes, dict):
        raw_quotes = {}
    quotes: dict[str, dict[str, Any]] = {}
    for symbol in symbols:
        quote = raw_quotes.get(symbol) or raw_quotes.get(symbol.upper()) or {}
        if not isinstance(quote, dict):
            quote = {}
        bid = quote.get("bid") if "bid" in quote else quote.get("bp")
        ask = quote.get("ask") if "ask" in quote else quote.get("ap")
        quotes[symbol] = {"symbol": symbol, "bid": bid, "ask": ask}
    return {"quotes": quotes}


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{json.dumps(payload, separators=(',', ':'), sort_keys=True)}\n", encoding="utf-8")


def elapsed_ms(started_at: float) -> int:
    return max(0, int(round((time.monotonic() - started_at) * 1000)))


def market_open_start(now: datetime) -> str:
    market_day = now.astimezone(MARKET_TIMEZONE).date()
    market_open = datetime(market_day.year, market_day.month, market_day.day, 9, 30, tzinfo=MARKET_TIMEZONE)
    return market_open.astimezone(UTC).isoformat().replace("+00:00", "Z")


def stock_analysis_cli_path(value: str | None) -> str:
    if value:
        return value
    work_dir = os.environ.get("AUTONOMOUS_TRADER_WORK_DIR", "/tmp/autonomous-trader-work")
    return str(Path(work_dir) / "stock_analysis")


def run_stock_analysis_scan(
    *,
    stock_analysis_cli: str,
    cycle_dir: Path,
    analysis_context_path: Path,
    watchlist: list[str],
) -> dict[str, Any]:
    live_scan_input = cycle_dir / "live-scan-input.json"
    live_scan = cycle_dir / "live-scan.json"
    build_command = [
        stock_analysis_cli,
        "build-live-scan-input",
        "--bars",
        str(cycle_dir / "bars.json"),
        "--quotes",
        str(cycle_dir / "quotes.json"),
        "--account",
        str(cycle_dir / "account.json"),
        "--positions",
        str(cycle_dir / "positions.json"),
        "--open-orders",
        str(cycle_dir / "open-orders.json"),
        "--scorecards",
        str(cycle_dir / "scorecards.json"),
        "--analysis-context",
        str(analysis_context_path),
        "--require-live-state",
        "--max-input-age-seconds",
        "1800",
        "--output",
        str(live_scan_input),
    ]
    for symbol in watchlist:
        build_command.extend(["--watchlist", symbol])
    subprocess.run(build_command, check=True)
    subprocess.run(
        [stock_analysis_cli, "daytrading-scan", "--input", str(live_scan_input), "--output", str(live_scan)],
        check=True,
    )
    payload = json.loads(live_scan.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("scanner output must be a JSON object")
    return payload


def fetch_scan_inputs(
    *,
    alpaca: AlpacaRestClient,
    synthesis: SynthesisClient,
    symbols: list[str],
    start: str,
    end: str,
    feed: str,
    scorecard_limit: int,
    broker_state: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    inputs, _ = fetch_scan_inputs_with_metrics(
        alpaca=alpaca,
        synthesis=synthesis,
        symbols=symbols,
        start=start,
        end=end,
        feed=feed,
        scorecard_limit=scorecard_limit,
        broker_state=broker_state,
        session_id=session_id,
    )
    return inputs


def fetch_scan_inputs_with_metrics(
    *,
    alpaca: AlpacaRestClient,
    synthesis: SynthesisClient,
    symbols: list[str],
    start: str,
    end: str,
    feed: str,
    scorecard_limit: int,
    broker_state: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    started_at = time.monotonic()
    fetch_current_session = bool(optional_text(session_id, max_length=240))
    metrics: dict[str, Any] = {
        "brokerStateSource": "provided" if broker_state is not None else "fetched",
        "parallelFetchCount": 4 if fetch_current_session else 3,
    }
    if broker_state is None:
        raw_broker_state, broker_metrics = fetch_broker_state_with_metrics(alpaca)
        metrics["brokerStateMs"] = broker_metrics["totalMs"]
        metrics["brokerState"] = broker_metrics
    else:
        raw_broker_state = broker_state
        metrics["brokerStateMs"] = 0
        metrics["brokerState"] = {
            "parallelFetchCount": 0,
            "totalMs": 0,
            "source": "provided",
        }

    raw_account = raw_broker_state.get("account")
    if not isinstance(raw_account, dict):
        raise ValueError("broker account state must be an object")
    positions = raw_broker_state.get("positions")
    orders = raw_broker_state.get("orders")
    account = format_account(raw_account)

    def timed_bars() -> tuple[Any, int]:
        task_started_at = time.monotonic()
        payload = alpaca.data_get(
            "/stocks/bars",
            {
                "symbols": ",".join(symbols),
                "timeframe": "1Min",
                "start": start,
                "end": end,
                "limit": "1000",
                "feed": feed,
                "sort": "asc",
            },
        )
        return payload, elapsed_ms(task_started_at)

    def timed_quotes() -> tuple[Any, int]:
        task_started_at = time.monotonic()
        payload = format_latest_quotes(
            alpaca.data_get("/stocks/quotes/latest", {"symbols": ",".join(symbols), "feed": feed}),
            symbols,
        )
        return payload, elapsed_ms(task_started_at)

    def timed_scorecards() -> tuple[Any, int]:
        task_started_at = time.monotonic()
        payload = synthesis.get("/api/autotrader/scorecards", {"limit": str(scorecard_limit)})
        return payload, elapsed_ms(task_started_at)

    def timed_current_session() -> tuple[Any, int]:
        task_started_at = time.monotonic()
        payload = synthesis.get(f"/api/autotrader/sessions/{urllib.parse.quote(str(session_id))}", None)
        return payload, elapsed_ms(task_started_at)

    with ThreadPoolExecutor(max_workers=4 if fetch_current_session else 3) as executor:
        futures = {
            "bars": executor.submit(timed_bars),
            "quotes": executor.submit(timed_quotes),
            "scorecards": executor.submit(timed_scorecards),
        }
        if fetch_current_session:
            futures["currentSession"] = executor.submit(timed_current_session)
        bars, metrics["barsMs"] = futures["bars"].result()
        quotes, metrics["quotesMs"] = futures["quotes"].result()
        scorecards, metrics["scorecardsMs"] = futures["scorecards"].result()
        current_session = None
        if fetch_current_session:
            current_session, metrics["currentSessionMs"] = futures["currentSession"].result()

    metrics["totalMs"] = elapsed_ms(started_at)
    inputs = {
        "account.json": account,
        "positions.json": {"positions": positions if isinstance(positions, list) else []},
        "open-orders.json": {"orders": orders if isinstance(orders, list) else []},
        "bars.json": bars,
        "quotes.json": quotes,
        "scorecards.json": scorecards,
        "watchlist.json": {"watchlist": symbols},
    }
    if fetch_current_session:
        inputs["current-session.json"] = current_session
    return inputs, metrics


def summarize_scan(
    cycle: int,
    cycle_dir: Path,
    scan: dict[str, Any],
    symbols: list[str],
    *,
    retained_cycles: int,
    removed_cycle_dirs: list[str],
) -> dict[str, Any]:
    results = scan.get("results")
    if not isinstance(results, list):
        results = []
    top_results = []
    for result in results[:10]:
        if not isinstance(result, dict):
            continue
        top_results.append(
            {
                key: result.get(key)
                for key in (
                    "symbol",
                    "bars",
                    "setup_type",
                    "setup_grade",
                    "fat_pitch",
                    "expected_r",
                    "no_trade_reason",
                    "last",
                    "vwap",
                    "spread_pct",
                    "liquidity_score",
                    "momentum_score",
                    "risk_notes",
                    "scorecard_sample_size",
                    "scorecard_avg_realized_r",
                    "scorecard_confidence",
                    "current_session_loss_lockout",
                    "current_session_loss_limit",
                )
            }
        )
    return {
        "ok": True,
        "cycle": cycle,
        "cycleDir": str(cycle_dir),
        "retainedCycles": retained_cycles,
        "removedCycleDirs": removed_cycle_dirs,
        "watchlist": symbols,
        "resultCount": len(results),
        "topResults": top_results,
        "scorecardInfluence": scorecard_usage_summary(scan),
        "scorecardOverlay": scan.get("scorecardOverlay"),
        "currentSessionLossLockout": scan.get("currentSessionLossLockout"),
        "currentSessionLossLimit": scan.get("currentSessionLossLimit"),
    }


def optional_text(value: Any, *, max_length: int | None = None) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if max_length is not None and len(text) > max_length:
        return text[: max_length - 1].rstrip() + "..."
    return text


def numeric_text(value: Any) -> str | None:
    text = optional_text(value)
    if text is None:
        return None
    try:
        return str(Decimal(text))
    except InvalidOperation:
        return None


def scorecard_collection(payload: Any, key: str) -> list[Any]:
    if not isinstance(payload, dict):
        return []
    value = payload.get(key)
    if isinstance(value, list):
        return value
    data = payload.get("data")
    if isinstance(data, dict) and isinstance(data.get(key), list):
        return data[key]
    if key == "scorecards" and isinstance(data, list):
        return data
    return []


def int_text_value(value: Any) -> int:
    text = optional_text(value)
    if text is None:
        return 0
    try:
        return int(Decimal(text))
    except (InvalidOperation, ValueError):
        return 0


def decimal_value(value: Any) -> Decimal | None:
    text = optional_text(value)
    if text is None:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def scorecard_readback_summary(payload: Any) -> dict[str, Any]:
    scorecards = scorecard_collection(payload, "scorecards")
    setup_examples = scorecard_collection(payload, "setupExamples")
    scorecard_count = len(scorecards)
    total_sample_size = 0
    nonzero_sample_count = 0
    positive_avg_r_count = 0
    negative_avg_r_count = 0
    symbols: list[str] = []
    symbol_seen: set[str] = set()
    top_scorecards: list[dict[str, Any]] = []

    for item in scorecards:
        if not isinstance(item, dict):
            continue
        sample_size = int_text_value(item.get("sampleSize") or item.get("sample_size"))
        total_sample_size += sample_size
        if sample_size > 0:
            nonzero_sample_count += 1

        avg_r = decimal_value(item.get("avgRealizedR") or item.get("avg_realized_r"))
        if avg_r is not None and avg_r > 0:
            positive_avg_r_count += 1
        if avg_r is not None and avg_r < 0:
            negative_avg_r_count += 1

        symbol = optional_text(item.get("symbol"), max_length=32)
        if symbol and symbol.upper() not in symbol_seen:
            symbol_seen.add(symbol.upper())
            symbols.append(symbol.upper())

        if len(top_scorecards) < 10:
            top_scorecards.append(
                {
                    "key": optional_text(item.get("key"), max_length=240),
                    "symbol": symbol.upper() if symbol else None,
                    "setupType": optional_text(item.get("setupType") or item.get("setup_type"), max_length=120),
                    "setupGrade": setup_grade(item.get("setupGrade") or item.get("setup_grade")),
                    "regime": optional_text(item.get("regime"), max_length=120),
                    "timeBucket": optional_text(item.get("timeBucket") or item.get("time_bucket"), max_length=80),
                    "sampleSize": sample_size,
                    "avgRealizedR": numeric_text(item.get("avgRealizedR") or item.get("avg_realized_r")),
                    "confidence": numeric_text(item.get("confidence")),
                }
            )

    payload_hash = hashlib.sha256(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")).hexdigest()
    return {
        "stage": "before_stock_analysis_scan",
        "scorecardCount": scorecard_count,
        "setupExampleCount": len(setup_examples),
        "totalSampleSize": total_sample_size,
        "nonzeroSampleScorecardCount": nonzero_sample_count,
        "positiveAvgRScorecardCount": positive_avg_r_count,
        "negativeAvgRScorecardCount": negative_avg_r_count,
        "symbols": symbols[:20],
        "topScorecards": top_scorecards,
        "payloadHash": payload_hash,
    }


def scorecard_usage_summary(scan: dict[str, Any]) -> dict[str, Any]:
    results = scan.get("results")
    if not isinstance(results, list):
        results = []
    used_results = 0
    top_results: list[dict[str, Any]] = []
    for result in results:
        if not isinstance(result, dict):
            continue
        sample_size = int_text_value(result.get("scorecard_sample_size") or result.get("scorecardSampleSize"))
        if sample_size > 0:
            used_results += 1
        if len(top_results) < 10:
            top_results.append(
                {
                    "symbol": optional_text(result.get("symbol"), max_length=32),
                    "setupType": setup_type(result.get("setup_type") or result.get("setupType")),
                    "setupGrade": setup_grade(result.get("setup_grade") or result.get("setupGrade")),
                    "scorecardSampleSize": sample_size,
                    "scorecardAvgRealizedR": numeric_text(
                        result.get("scorecard_avg_realized_r") or result.get("scorecardAvgRealizedR")
                    ),
                    "scorecardConfidence": numeric_text(
                        result.get("scorecard_confidence") or result.get("scorecardConfidence")
                    ),
                }
            )
    return {
        "resultCount": len(results),
        "scorecardInfluencedResultCount": used_results,
        "topResults": top_results,
    }


def scorecard_match_text(value: Any) -> str | None:
    text = optional_text(value)
    return text.lower() if text else None


def scorecard_overlay_for_result(result: dict[str, Any], scorecards: list[Any]) -> dict[str, str] | None:
    symbol = optional_text(result.get("symbol"), max_length=32)
    setup = scorecard_match_text(result.get("setup_type") or result.get("setupType"))
    grade = setup_grade(result.get("setup_grade") or result.get("setupGrade"))
    if not symbol or not setup or grade not in ACTIONABLE_SETUP_GRADES:
        return None
    regime = scorecard_match_text(result.get("regime"))
    time_bucket = scorecard_match_text(result.get("time_bucket") or result.get("timeBucket"))
    matches: list[dict[str, Any]] = []
    for scorecard in scorecards:
        if not isinstance(scorecard, dict):
            continue
        scorecard_symbol = optional_text(scorecard.get("symbol"), max_length=32)
        if not scorecard_symbol or scorecard_symbol.upper() != symbol.upper():
            continue
        if scorecard_match_text(scorecard.get("setupType") or scorecard.get("setup_type")) != setup:
            continue
        if setup_grade(scorecard.get("setupGrade") or scorecard.get("setup_grade")) != grade:
            continue
        matches.append(scorecard)
    if not matches:
        return None
    contextual_matches = [
        scorecard
        for scorecard in matches
        if (not regime or scorecard_match_text(scorecard.get("regime")) == regime)
        and (not time_bucket or scorecard_match_text(scorecard.get("timeBucket") or scorecard.get("time_bucket")) == time_bucket)
    ]
    selected = contextual_matches or matches
    weighted_sum = Decimal("0")
    sample_total = 0
    confidence = Decimal("0")
    for scorecard in selected:
        sample_size = int_text_value(scorecard.get("sampleSize") or scorecard.get("sample_size"))
        avg_r = decimal_value(scorecard.get("avgRealizedR") or scorecard.get("avg_realized_r"))
        if sample_size <= 0 or avg_r is None:
            continue
        weighted_sum += avg_r * Decimal(sample_size)
        sample_total += sample_size
        confidence = max(confidence, decimal_value(scorecard.get("confidence")) or Decimal("0"))
    if sample_total <= 0:
        return None
    return {
        "scorecard_sample_size": str(sample_total),
        "scorecard_avg_realized_r": str(weighted_sum / Decimal(sample_total)),
        "scorecard_confidence": str(confidence),
    }


def overlay_scorecards_on_scan(scan: dict[str, Any], scorecard_payload: Any) -> dict[str, Any]:
    results = scan.get("results")
    if not isinstance(results, list):
        return scan
    scorecards = scorecard_collection(scorecard_payload, "scorecards")
    if not scorecards:
        return scan
    enriched_results: list[Any] = []
    applied_count = 0
    for result in results:
        if not isinstance(result, dict):
            enriched_results.append(result)
            continue
        if int_text_value(result.get("scorecard_sample_size") or result.get("scorecardSampleSize")) > 0:
            enriched_results.append(result)
            continue
        overlay = scorecard_overlay_for_result(result, scorecards)
        if overlay is None:
            enriched_results.append(result)
            continue
        enriched = {**result, **overlay, "scorecard_overlay_source": "synthesis_scorecards"}
        enriched_results.append(enriched)
        applied_count += 1
    return {
        **scan,
        "results": enriched_results,
        "scorecardOverlay": {
            "sourceScorecardCount": len(scorecards),
            "appliedResultCount": applied_count,
        },
    }


def session_detail_object(payload: Any) -> dict[str, Any]:
    return payload if isinstance(payload, dict) else {}


def session_detail_collection(payload: Any, key: str) -> list[Any]:
    detail = session_detail_object(payload)
    value = detail.get(key)
    return value if isinstance(value, list) else []


def normalized_loss_key(symbol: Any, setup: Any = None) -> tuple[str, str | None] | None:
    symbol_text = optional_text(symbol, max_length=32)
    if not symbol_text:
        return None
    setup_text = setup_type(setup) if setup is not None else None
    return symbol_text.upper(), setup_text if setup_text and setup_text != "no_trade" else None


def session_ticket_lookup(payload: Any) -> dict[str, dict[str, Any]]:
    tickets: dict[str, dict[str, Any]] = {}
    for ticket in session_detail_collection(payload, "tradeTickets"):
        if not isinstance(ticket, dict):
            continue
        ticket_id = optional_text(ticket.get("id") or ticket.get("ticketId"), max_length=240)
        if ticket_id:
            tickets[ticket_id] = ticket
    return tickets


def session_losing_round_trip_keys(payload: Any) -> dict[tuple[str, str | None], dict[str, Any]]:
    orders = [order for order in session_detail_collection(payload, "orders") if isinstance(order, dict)]
    by_client_order_id = {
        str(order["clientOrderId"]): order
        for order in orders
        if optional_text(order.get("clientOrderId"), max_length=240)
    }
    tickets_by_id = session_ticket_lookup(payload)
    losing: dict[tuple[str, str | None], dict[str, Any]] = {}
    for exit_order in orders:
        payload_value = exit_order.get("brokerPayload")
        broker_payload = payload_value if isinstance(payload_value, dict) else {}
        parent_client_order_id = optional_text(
            broker_payload.get("parentClientOrderId") or exit_order.get("parentClientOrderId"),
            max_length=240,
        )
        if not parent_client_order_id:
            continue
        parent = by_client_order_id.get(parent_client_order_id)
        if not isinstance(parent, dict):
            continue
        parent_side = optional_text(parent.get("side"), max_length=32)
        exit_side = optional_text(exit_order.get("side"), max_length=32)
        if parent_side != "buy" or exit_side != "sell":
            continue
        parent_broker_payload = parent.get("brokerPayload") if isinstance(parent.get("brokerPayload"), dict) else {}
        parent_price = decimal_value(
            parent.get("filledAvgPrice") or parent.get("filled_avg_price") or parent_broker_payload.get("filled_avg_price")
        )
        exit_price = decimal_value(
            exit_order.get("filledAvgPrice")
            or exit_order.get("filled_avg_price")
            or broker_payload.get("filled_avg_price")
        )
        if parent_price is None or exit_price is None or exit_price >= parent_price:
            continue
        ticket = tickets_by_id.get(str(parent.get("ticketId") or exit_order.get("ticketId") or ""))
        setup = ticket.get("setupType") if isinstance(ticket, dict) else None
        symbol = parent.get("symbol") or exit_order.get("symbol")
        symbol_key = normalized_loss_key(symbol)
        setup_key = normalized_loss_key(symbol, setup)
        details = {
            "symbol": optional_text(symbol, max_length=32).upper() if optional_text(symbol, max_length=32) else None,
            "setupType": setup_type(setup) if setup is not None else None,
            "parentClientOrderId": parent_client_order_id,
            "exitClientOrderId": exit_order.get("clientOrderId"),
            "entryPrice": str(parent_price),
            "exitPrice": str(exit_price),
        }
        if symbol_key:
            losing[symbol_key] = details
        if setup_key:
            losing[setup_key] = details
    return losing


def current_session_loss_for_result(
    result: dict[str, Any],
    losing_keys: dict[tuple[str, str | None], dict[str, Any]],
) -> dict[str, Any] | None:
    symbol = optional_text(result.get("symbol"), max_length=32)
    if not symbol:
        return None
    setup = setup_type(result.get("setup_type") or result.get("setupType"))
    setup_key = normalized_loss_key(symbol, setup)
    symbol_key = normalized_loss_key(symbol)
    if setup_key and setup_key in losing_keys:
        return {**losing_keys[setup_key], "lockoutScope": "symbol_setup"}
    if symbol_key and symbol_key in losing_keys:
        return {**losing_keys[symbol_key], "lockoutScope": "symbol"}
    return None


def current_session_loss_limit(payload: Any) -> dict[str, Any] | None:
    losses_by_parent = current_session_losing_round_trips(payload)
    if len(losses_by_parent) < MAX_CURRENT_SESSION_LOSING_ROUND_TRIPS:
        return None
    symbols = sorted(
        {
            symbol
            for loss in losses_by_parent.values()
            if (symbol := optional_text(loss.get("symbol"), max_length=32))
        }
    )
    return {
        "reason": "current_session_loss_limit_reached",
        "losingRoundTripCount": len(losses_by_parent),
        "maxLosingRoundTrips": MAX_CURRENT_SESSION_LOSING_ROUND_TRIPS,
        "symbols": symbols[:20],
    }


def current_session_losing_round_trips(payload: Any) -> dict[str, dict[str, Any]]:
    losses_by_parent: dict[str, dict[str, Any]] = {}
    for loss in session_losing_round_trip_keys(payload).values():
        parent_id = optional_text(loss.get("parentClientOrderId"), max_length=240)
        if parent_id:
            losses_by_parent[parent_id] = loss
    return losses_by_parent


def post_loss_recovery_gate_no_trade_reason(result: dict[str, Any]) -> str | None:
    grade = setup_grade(result.get("setup_grade") or result.get("setupGrade"))
    if grade not in {"A+", "A"}:
        return "current_session_post_loss_requires_a_grade"
    expected_r = decimal_value(result.get("expected_r") or result.get("expectedR"))
    if expected_r is None or expected_r < MIN_POST_LOSS_EXPECTED_R:
        return "current_session_post_loss_expected_r_below_floor"
    bracket_r = decimal_value(derived_bracket_for_scan_result(result).get("actualBracketR"))
    if bracket_r is None or bracket_r < MIN_POST_LOSS_BRACKET_R:
        return "current_session_post_loss_bracket_r_below_floor"
    sample_size, avg_realized_r, _confidence = scorecard_edge_values(result)
    if sample_size < MIN_SCORECARD_RISK_SCALE_SAMPLE_SIZE:
        return "current_session_post_loss_scorecard_repeat_sample_required"
    if avg_realized_r is None or avg_realized_r < MIN_POST_LOSS_SCORECARD_AVG_REALIZED_R:
        return "current_session_post_loss_scorecard_avg_r_below_floor"
    return None


def post_loss_recovery_gate(losing_round_trips: dict[str, dict[str, Any]]) -> dict[str, Any]:
    symbols = sorted(
        {
            symbol
            for loss in losing_round_trips.values()
            if (symbol := optional_text(loss.get("symbol"), max_length=32))
        }
    )
    return {
        "reason": "current_session_post_loss_recovery_gate",
        "losingRoundTripCount": len(losing_round_trips),
        "symbols": symbols[:20],
        "minimumExpectedR": str(MIN_POST_LOSS_EXPECTED_R),
        "minimumBracketR": str(MIN_POST_LOSS_BRACKET_R),
        "minimumScorecardAvgRealizedR": str(MIN_POST_LOSS_SCORECARD_AVG_REALIZED_R),
        "minimumScorecardSampleSize": MIN_SCORECARD_RISK_SCALE_SAMPLE_SIZE,
        "allowedSetupGrades": ["A+", "A"],
    }


def overlay_current_session_loss_lockout(scan: dict[str, Any], current_session_payload: Any) -> dict[str, Any]:
    results = scan.get("results")
    if not isinstance(results, list):
        return scan
    losing_keys = session_losing_round_trip_keys(current_session_payload)
    if not losing_keys:
        return scan
    loss_limit = current_session_loss_limit(current_session_payload)
    losing_round_trips = current_session_losing_round_trips(current_session_payload)
    recovery_gate = (
        post_loss_recovery_gate(losing_round_trips)
        if loss_limit is None and losing_round_trips
        else None
    )
    enriched_results: list[Any] = []
    applied_count = 0
    blocked_symbols: list[str] = []
    for result in results:
        if not isinstance(result, dict):
            enriched_results.append(result)
            continue
        if is_scanner_no_trade_result(result):
            enriched_results.append(result)
            continue
        if loss_limit is not None:
            symbol = optional_text(result.get("symbol"), max_length=32)
            if symbol and symbol.upper() not in blocked_symbols:
                blocked_symbols.append(symbol.upper())
            enriched_results.append(
                {
                    **result,
                    "no_trade_reason": "current_session_loss_limit_reached",
                    "current_session_loss_limit": loss_limit,
                }
            )
            applied_count += 1
            continue
        lockout = current_session_loss_for_result(result, losing_keys)
        if lockout is None:
            recovery_reason = (
                post_loss_recovery_gate_no_trade_reason(result)
                if recovery_gate is not None
                else None
            )
            if recovery_reason is None:
                enriched_results.append(result)
                continue
            symbol = optional_text(result.get("symbol"), max_length=32)
            if symbol and symbol.upper() not in blocked_symbols:
                blocked_symbols.append(symbol.upper())
            enriched_results.append(
                {
                    **result,
                    "no_trade_reason": recovery_reason,
                    "current_session_recovery_gate": recovery_gate,
                }
            )
            applied_count += 1
            continue
        symbol = optional_text(result.get("symbol"), max_length=32)
        if symbol and symbol.upper() not in blocked_symbols:
            blocked_symbols.append(symbol.upper())
        enriched_results.append(
            {
                **result,
                "no_trade_reason": "current_session_loss_lockout",
                "current_session_loss_lockout": lockout,
            }
        )
        applied_count += 1
    return {
        **scan,
        "results": enriched_results,
        "currentSessionLossLockout": {
            "appliedResultCount": applied_count,
            "blockedSymbols": blocked_symbols[:20],
        },
        **({"currentSessionRecoveryGate": recovery_gate} if recovery_gate is not None else {}),
        **({"currentSessionLossLimit": loss_limit} if loss_limit is not None else {}),
    }


def record_scorecard_readback(
    *,
    synthesis: SynthesisClient,
    session_id: str,
    cycle: int,
    scorecard_readback: dict[str, Any],
) -> dict[str, Any]:
    if not session_id.strip():
        raise ValueError("session id is required when recording scorecard readback")
    scorecard_count = int_text_value(scorecard_readback.get("scorecardCount"))
    passed = scorecard_count > 0
    response = synthesis.post(
        "/api/autotrader/risk-checks",
        {
            "sessionId": session_id,
            "idempotencyKey": f"scorecard-readback-before-scan-cycle-{cycle}",
            "checkType": "scorecard_readback_before_scan",
            "passed": passed,
            "reason": "scorecards_available_before_scan" if passed else "scorecards_empty_before_scan",
            "payload": scorecard_readback,
        },
    )
    risk_check = response.get("riskCheck") if isinstance(response, dict) else None
    return {
        "riskCheckId": risk_check.get("id") if isinstance(risk_check, dict) else None,
        "passed": passed,
        "scorecardCount": scorecard_count,
        "payloadHash": scorecard_readback.get("payloadHash"),
    }


def setup_grade(value: Any) -> str:
    grade = optional_text(value)
    if grade in {"A+", "A", "B", "C", "blocked"}:
        return grade
    return "blocked"


def setup_type(value: Any) -> str:
    return optional_text(value, max_length=120) or "no_trade"


def schema_enum(value: Any, allowed: set[str], default: str) -> str:
    text = optional_text(value)
    if text in allowed:
        return text
    return default


def first_decimal_value(result: dict[str, Any], *keys: str) -> Decimal | None:
    for key in keys:
        value = decimal_value(result.get(key))
        if value is not None:
            return value
    return None


def result_side(result: dict[str, Any]) -> str:
    return schema_enum(result.get("side"), SYNTHESIS_SIDES, "buy")


def order_side_direction(side: str) -> str:
    return "sell" if side.startswith("sell") else "buy"


def bracket_r_value(*, side: str, entry: Decimal, stop: Decimal, target: Decimal) -> Decimal | None:
    direction = order_side_direction(side)
    if direction == "buy":
        risk = entry - stop
        reward = target - entry
    else:
        risk = stop - entry
        reward = entry - target
    if risk <= 0 or reward <= 0:
        return None
    return reward / risk


def derived_bracket_for_scan_result(result: dict[str, Any]) -> dict[str, Any]:
    side = result_side(result)
    direction = order_side_direction(side)
    entry = first_decimal_value(result, "entry_limit_price", "entryLimitPrice", "last")
    explicit_stop = first_decimal_value(result, "stop_price", "stopPrice")
    explicit_target = first_decimal_value(result, "target_price", "targetPrice")
    support = first_decimal_value(result, "support")
    resistance = first_decimal_value(result, "resistance")
    stop = explicit_stop
    target = explicit_target
    stop_source = "explicit" if stop is not None else None
    target_source = "explicit" if target is not None else None

    if entry is not None and stop is None:
        if direction == "buy" and support is not None and support < entry:
            stop = support
            stop_source = "support"
        elif direction == "sell" and resistance is not None and resistance > entry:
            stop = resistance
            stop_source = "resistance"

    if entry is not None and target is None:
        if direction == "buy" and resistance is not None and resistance > entry:
            target = resistance
            target_source = "resistance"
        elif direction == "sell" and support is not None and support < entry:
            target = support
            target_source = "support"

    missing = []
    if entry is None:
        missing.append("entryLimitPrice")
    if stop is None:
        missing.append("stopPrice")
    if target is None:
        missing.append("targetPrice")

    actual_r = bracket_r_value(side=side, entry=entry, stop=stop, target=target) if not missing else None
    return {
        "side": side,
        "entryLimitPrice": str(entry) if entry is not None else None,
        "stopPrice": str(stop) if stop is not None else None,
        "targetPrice": str(target) if target is not None else None,
        "actualBracketR": (
            normalized_quantized_decimal_text(actual_r, R_MULTIPLE_QUANT) if actual_r is not None else None
        ),
        "entrySource": "explicit_or_last" if entry is not None else None,
        "stopSource": stop_source,
        "targetSource": target_source,
        "missingFields": missing,
    }


def executable_bracket_no_trade_reason(result: dict[str, Any]) -> str | None:
    bracket = derived_bracket_for_scan_result(result)
    if bracket["missingFields"]:
        return "missing_executable_bracket_prices"
    actual_r = decimal_value(bracket.get("actualBracketR"))
    if actual_r is None:
        return "invalid_executable_bracket_prices"
    if actual_r < MIN_ACTIONABLE_BRACKET_R:
        return "actual_bracket_r_below_threshold"
    return None


def account_from_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {}
    account = payload.get("account")
    return account if isinstance(account, dict) else payload


def risk_budget_for_account(payload: dict[str, Any] | None) -> dict[str, str] | None:
    account = account_from_payload(payload)
    equity = parse_account_decimal(account.get("equity"))
    if equity is None or equity <= 0:
        return None
    daytrading_buying_power = parse_account_decimal(
        account.get("daytrading_buying_power") or account.get("daytrade_buying_power")
    )
    buying_power = parse_account_decimal(account.get("buying_power"))
    positive_buying_power = [
        value for value in (daytrading_buying_power, buying_power) if value is not None and value > 0
    ]
    max_position_notional = equity * MAX_POSITION_NOTIONAL_EQUITY_PCT
    if positive_buying_power:
        max_position_notional = min(max_position_notional, min(positive_buying_power))
    return {
        "source": "account_equity_stop_distance",
        "equity": quantized_decimal_text(equity, ACCOUNT_MONEY_QUANT),
        "baseRiskPct": normalized_quantized_decimal_text(BASE_RISK_EQUITY_PCT, ACCOUNT_RATIO_QUANT),
        "maxRiskPct": normalized_quantized_decimal_text(MAX_RISK_EQUITY_PCT, ACCOUNT_RATIO_QUANT),
        "maxPositionNotionalPct": normalized_quantized_decimal_text(
            MAX_POSITION_NOTIONAL_EQUITY_PCT, ACCOUNT_RATIO_QUANT
        ),
        "baseRiskDollars": quantized_decimal_text(equity * BASE_RISK_EQUITY_PCT, ACCOUNT_MONEY_QUANT),
        "maxRiskDollars": quantized_decimal_text(equity * MAX_RISK_EQUITY_PCT, ACCOUNT_MONEY_QUANT),
        "maxPositionNotionalDollars": quantized_decimal_text(max_position_notional, ACCOUNT_MONEY_QUANT),
    }


def position_size_for_bracket(
    *,
    bracket: dict[str, Any],
    recommended_risk_dollars: Decimal,
    max_position_notional_dollars: Decimal | None,
) -> dict[str, str | None]:
    entry = decimal_value(bracket.get("entryLimitPrice"))
    stop = decimal_value(bracket.get("stopPrice"))
    if entry is None or stop is None or entry <= 0:
        return {"plannedQuantity": None, "reason": "missing_entry_or_stop_for_position_size"}
    per_share_risk = abs(entry - stop)
    if per_share_risk <= 0:
        return {"plannedQuantity": None, "reason": "non_positive_per_share_risk"}
    quantity_from_risk = recommended_risk_dollars / per_share_risk
    quantity_from_notional = (
        max_position_notional_dollars / entry
        if max_position_notional_dollars is not None and max_position_notional_dollars > 0
        else quantity_from_risk
    )
    quantity_text = floored_decimal_int_text(min(quantity_from_risk, quantity_from_notional))
    if quantity_text is None:
        return {
            "plannedQuantity": None,
            "reason": "deterministic_position_size_not_positive",
            "perShareRiskDollars": quantized_decimal_text(per_share_risk, ACCOUNT_MONEY_QUANT),
        }
    quantity = Decimal(quantity_text)
    return {
        "plannedQuantity": quantity_text,
        "reason": "account_risk_budget_stop_distance",
        "perShareRiskDollars": quantized_decimal_text(per_share_risk, ACCOUNT_MONEY_QUANT),
        "plannedMaxLossDollars": quantized_decimal_text(quantity * per_share_risk, ACCOUNT_MONEY_QUANT),
        "plannedNotionalDollars": quantized_decimal_text(quantity * entry, ACCOUNT_MONEY_QUANT),
    }


def result_no_trade_reason(
    result: dict[str, Any],
    grade: str,
    type_: str,
    account: dict[str, Any] | None = None,
) -> str | None:
    reason = optional_text(result.get("no_trade_reason") or result.get("noTradeReason"), max_length=1000)
    if reason:
        return reason
    if grade in {"C", "blocked"}:
        return "scanner_blocked_grade"
    if type_ == "no_trade":
        return "scanner_no_trade"
    scorecard_sample_size = int_text_value(result.get("scorecard_sample_size") or result.get("scorecardSampleSize"))
    scorecard_avg_r = decimal_value(result.get("scorecard_avg_realized_r") or result.get("scorecardAvgRealizedR"))
    if scorecard_sample_size > 0 and scorecard_avg_r is not None and scorecard_avg_r < 0:
        return "scorecard_avg_realized_r_negative"
    expected_r = decimal_value(result.get("expected_r") or result.get("expectedR"))
    if expected_r is None:
        return "missing_expected_r"
    if expected_r < MIN_ACTIONABLE_EXPECTED_R:
        return "expected_r_below_threshold"
    bracket_reason = executable_bracket_no_trade_reason(result)
    if bracket_reason:
        return bracket_reason
    if scorecard_sample_size <= 0 or scorecard_avg_r is None or scorecard_avg_r <= 0:
        return "positive_scorecard_edge_required"
    if scorecard_avg_r < MIN_SCORECARD_ACTIONABLE_AVG_REALIZED_R:
        return "scorecard_avg_realized_r_below_actionable_floor"
    if scorecard_sample_size < MIN_SCORECARD_RISK_SCALE_SAMPLE_SIZE:
        return "positive_scorecard_repeat_sample_required"
    risk_directive = scorecard_risk_directive(result, account=account)
    if account is not None and risk_directive is not None and not risk_directive.get("plannedQuantity"):
        return optional_text(risk_directive.get("positionSizeReason"), max_length=120) or "deterministic_size_missing"
    return None


def is_scanner_no_trade_result(result: dict[str, Any]) -> bool:
    return setup_type(result.get("setup_type") or result.get("setupType")) == "no_trade"


def ticket_payload_for_scan_result(
    *,
    session_id: str,
    cycle: int,
    index: int,
    result: dict[str, Any],
    account: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    symbol = optional_text(result.get("symbol"), max_length=32)
    if not symbol:
        return None
    grade = setup_grade(result.get("setup_grade") or result.get("setupGrade"))
    type_ = setup_type(result.get("setup_type") or result.get("setupType"))
    side = result_side(result)
    bracket = derived_bracket_for_scan_result(result)
    no_trade_reason = result_no_trade_reason(result, grade, type_, account=account)
    expected_r = numeric_text(result.get("expected_r") or result.get("expectedR"))
    blocked = no_trade_reason is not None
    idempotency_key = f"scan-cycle-{cycle}-{index}-{symbol.upper()}-{type_}-{grade}".replace(" ", "-")
    idempotency_key = re.sub(r"[^A-Za-z0-9_.:-]+", "-", idempotency_key)[:240]
    thesis = optional_text(result.get("thesis"), max_length=2000) or (
        f"Live scan cycle {cycle} produced {symbol.upper()} {grade} {type_}"
        + (f" with expectedR {expected_r}" if expected_r else "")
    )
    entry_trigger = optional_text(result.get("entry_trigger") or result.get("entryTrigger"), max_length=1200)
    invalidation = optional_text(result.get("invalidation"), max_length=1200)
    risk_directive = scorecard_risk_directive(result, account=account)
    risk_dollars = (
        optional_text(risk_directive.get("recommendedRiskDollars"), max_length=80)
        if isinstance(risk_directive, dict)
        else None
    ) or numeric_text(result.get("risk_dollars") or result.get("riskDollars"))
    planned_quantity = (
        optional_text(risk_directive.get("plannedQuantity"), max_length=80) if isinstance(risk_directive, dict) else None
    ) or numeric_text(result.get("planned_quantity") or result.get("plannedQuantity"))

    return {
        "sessionId": session_id,
        "idempotencyKey": idempotency_key,
        "symbol": symbol.upper(),
        "instrument": schema_enum(result.get("instrument"), SYNTHESIS_INSTRUMENTS, "stock"),
        "side": side,
        "setupType": type_,
        "setupGrade": grade,
        "fatPitch": bool(result.get("fat_pitch") or result.get("fatPitch") or False),
        "regime": optional_text(result.get("regime"), max_length=120) or "intraday_live_scan",
        "timeBucket": optional_text(result.get("time_bucket") or result.get("timeBucket"), max_length=80)
        or "market_session",
        "thesis": thesis,
        "entryTrigger": entry_trigger or ("blocked_by_scanner" if blocked else "scanner_candidate_requires_guard"),
        "invalidation": invalidation or ("no broker order" if blocked else "strategy guard must approve before broker order"),
        "entryLimitPrice": bracket["entryLimitPrice"],
        "stopPrice": bracket["stopPrice"],
        "targetPrice": bracket["targetPrice"],
        "expectedR": expected_r,
        "actualBracketR": bracket["actualBracketR"],
        "riskDollars": risk_dollars,
        "plannedQuantity": planned_quantity,
        "protectionType": optional_text(result.get("protection_type") or result.get("protectionType"), max_length=80)
        or ("none_no_order" if blocked else "bracket_required"),
        "brokerOrderPlan": {
            "source": "live_scan_cycle",
            "cycle": cycle,
            "resultIndex": index,
            "riskDirective": risk_directive,
            "executableBracket": bracket,
            "raw": result,
        },
        "status": "blocked" if blocked else "candidate",
        "noTradeReason": no_trade_reason,
    }


def record_scan_tickets(
    *,
    synthesis: SynthesisClient,
    session_id: str,
    cycle: int,
    scan: dict[str, Any],
    limit: int,
    account: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if not session_id.strip():
        raise ValueError("session id is required when recording scan tickets")
    results = scan.get("results")
    if not isinstance(results, list):
        return []
    recorded: list[dict[str, Any]] = []
    for index, result in enumerate(results[: max(0, limit)], start=1):
        if not isinstance(result, dict):
            continue
        payload = ticket_payload_for_scan_result(
            session_id=session_id,
            cycle=cycle,
            index=index,
            result=result,
            account=account,
        )
        if payload is None:
            continue
        response = synthesis.post("/api/autotrader/trade-tickets", payload)
        ticket = response.get("ticket") if isinstance(response, dict) else None
        recorded.append(
            {
                "symbol": payload["symbol"],
                "setupType": payload["setupType"],
                "setupGrade": payload["setupGrade"],
                "status": payload["status"],
                "noTradeReason": payload["noTradeReason"],
                "ticketId": ticket.get("id") if isinstance(ticket, dict) else None,
                "idempotencyKey": payload["idempotencyKey"],
                "actualBracketR": payload["actualBracketR"],
                "riskDollars": payload["riskDollars"],
                "plannedQuantity": payload["plannedQuantity"],
                "scorecardSampleSize": int_text_value(
                    result.get("scorecard_sample_size") or result.get("scorecardSampleSize")
                ),
                "scorecardAvgRealizedR": numeric_text(
                    result.get("scorecard_avg_realized_r") or result.get("scorecardAvgRealizedR")
                ),
                "scorecardConfidence": numeric_text(
                    result.get("scorecard_confidence") or result.get("scorecardConfidence")
                ),
            }
        )
    return recorded


def scorecard_edge_values(result: dict[str, Any]) -> tuple[int, Decimal | None, Decimal]:
    sample_size = int_text_value(result.get("scorecard_sample_size") or result.get("scorecardSampleSize"))
    avg_realized_r = decimal_value(result.get("scorecard_avg_realized_r") or result.get("scorecardAvgRealizedR"))
    confidence = decimal_value(result.get("scorecard_confidence") or result.get("scorecardConfidence")) or Decimal("0")
    return sample_size, avg_realized_r, confidence


def scorecard_edge_weight(sample_size: int) -> Decimal:
    if sample_size <= 0:
        return Decimal("0")
    return min(Decimal("1"), Decimal(sample_size) / Decimal(MIN_SCORECARD_RISK_SCALE_SAMPLE_SIZE))


def scorecard_risk_directive(result: dict[str, Any], account: dict[str, Any] | None = None) -> dict[str, Any] | None:
    sample_size, avg_realized_r, confidence = scorecard_edge_values(result)
    if sample_size <= 0 or avg_realized_r is None or avg_realized_r <= 0:
        return None
    if avg_realized_r < MIN_SCORECARD_ACTIONABLE_AVG_REALIZED_R:
        return None
    risk_multiplier = (
        min(MAX_SCORECARD_RISK_MULTIPLIER, max(Decimal("1.0"), avg_realized_r))
        if sample_size >= MIN_SCORECARD_RISK_SCALE_SAMPLE_SIZE
        else Decimal("1.0")
    )
    directive: dict[str, Any] = {
        "source": "scorecard_realized_r",
        "mode": "scale_positive_realized_edge",
        "riskMultiplier": str(risk_multiplier),
        "maxRiskMultiplier": str(MAX_SCORECARD_RISK_MULTIPLIER),
        "minimumScaleSampleSize": MIN_SCORECARD_RISK_SCALE_SAMPLE_SIZE,
        "scorecardSampleSize": sample_size,
        "scorecardAvgRealizedR": str(avg_realized_r),
        "scorecardConfidence": str(confidence),
        "reason": (
            "positive_scorecard_edge"
            if sample_size >= MIN_SCORECARD_RISK_SCALE_SAMPLE_SIZE
            else "positive_scorecard_edge_pending_repeat_sample"
        ),
    }
    risk_dollars = decimal_value(result.get("risk_dollars") or result.get("riskDollars"))
    risk_budget = risk_budget_for_account(account)
    if risk_dollars is not None and risk_dollars > 0:
        directive["baseRiskDollars"] = str(risk_dollars)
        recommended_risk_dollars = risk_dollars * risk_multiplier
    elif risk_budget is not None:
        directive["accountRiskBudget"] = risk_budget
        base_risk = decimal_value(risk_budget.get("baseRiskDollars"))
        recommended_risk_dollars = base_risk * risk_multiplier if base_risk is not None else None
        if base_risk is not None:
            directive["baseRiskDollars"] = risk_budget["baseRiskDollars"]
    else:
        recommended_risk_dollars = None
    if recommended_risk_dollars is not None and recommended_risk_dollars > 0:
        max_risk = decimal_value(risk_budget.get("maxRiskDollars")) if risk_budget is not None else None
        if max_risk is not None and max_risk > 0 and recommended_risk_dollars > max_risk:
            recommended_risk_dollars = max_risk
            directive["cappedByAccountRiskBudget"] = True
        if risk_budget is None:
            directive["recommendedRiskDollars"] = str(recommended_risk_dollars)
        else:
            directive["recommendedRiskDollars"] = quantized_decimal_text(
                recommended_risk_dollars, ACCOUNT_MONEY_QUANT
            )
            max_notional = decimal_value(risk_budget.get("maxPositionNotionalDollars"))
            position_size = position_size_for_bracket(
                bracket=derived_bracket_for_scan_result(result),
                recommended_risk_dollars=recommended_risk_dollars,
                max_position_notional_dollars=max_notional,
            )
            directive.update({key: value for key, value in position_size.items() if value is not None})
            directive["positionSizeReason"] = str(position_size.get("reason"))
    return directive


def candidate_score(result: dict[str, Any]) -> tuple[Decimal, Decimal, int, int, Decimal]:
    grade = setup_grade(result.get("setup_grade") or result.get("setupGrade"))
    grade_score = {"A+": 3, "A": 2, "B": 1}.get(grade, 0)
    expected_r = decimal_value(result.get("expected_r") or result.get("expectedR")) or Decimal("0")
    bracket_r = decimal_value(derived_bracket_for_scan_result(result).get("actualBracketR"))
    executable_r = min(expected_r, bracket_r) if bracket_r is not None else expected_r
    sample_size, avg_realized_r, confidence = scorecard_edge_values(result)
    scorecard_edge = (
        avg_realized_r * scorecard_edge_weight(sample_size)
        if sample_size > 0 and avg_realized_r is not None and avg_realized_r > 0
        else Decimal("0")
    )
    return executable_r + scorecard_edge, executable_r, grade_score, sample_size, confidence


def actionable_candidate_for_result(
    *,
    cycle: int,
    index: int,
    result: dict[str, Any],
    tickets_by_idempotency_key: dict[str, dict[str, Any]],
    account: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    payload = ticket_payload_for_scan_result(
        session_id="decision-summary",
        cycle=cycle,
        index=index,
        result=result,
        account=account,
    )
    if payload is None:
        return None
    grade = str(payload["setupGrade"])
    expected_r = decimal_value(payload.get("expectedR"))
    if payload.get("status") != "candidate" or grade not in ACTIONABLE_SETUP_GRADES:
        return None
    if expected_r is None or expected_r < MIN_ACTIONABLE_EXPECTED_R:
        return None
    ticket = tickets_by_idempotency_key.get(str(payload["idempotencyKey"]), {})
    return {
        "resultIndex": index,
        "symbol": payload["symbol"],
        "side": payload["side"],
        "setupType": payload["setupType"],
        "setupGrade": grade,
        "expectedR": payload.get("expectedR"),
        "entryLimitPrice": payload.get("entryLimitPrice"),
        "stopPrice": payload.get("stopPrice"),
        "targetPrice": payload.get("targetPrice"),
        "riskDollars": payload.get("riskDollars"),
        "plannedQuantity": payload.get("plannedQuantity"),
        "actualBracketR": payload.get("actualBracketR"),
        "riskDirective": scorecard_risk_directive(result, account=account),
        "scorecardSampleSize": int_text_value(result.get("scorecard_sample_size") or result.get("scorecardSampleSize")),
        "scorecardAvgRealizedR": numeric_text(
            result.get("scorecard_avg_realized_r") or result.get("scorecardAvgRealizedR")
        ),
        "scorecardConfidence": numeric_text(result.get("scorecard_confidence") or result.get("scorecardConfidence")),
        "ticketId": ticket.get("ticketId"),
        "idempotencyKey": payload["idempotencyKey"],
        "entryTrigger": payload.get("entryTrigger"),
        "invalidation": payload.get("invalidation"),
        "protectionType": payload.get("protectionType"),
    }


def decision_summary_for_scan(
    *,
    cycle: int,
    scan: dict[str, Any],
    recorded_tickets: list[dict[str, Any]],
    account: dict[str, Any] | None = None,
) -> dict[str, Any]:
    results = scan.get("results")
    if not isinstance(results, list):
        results = []
    tickets_by_idempotency_key = {
        str(ticket.get("idempotencyKey")): ticket
        for ticket in recorded_tickets
        if isinstance(ticket, dict) and optional_text(ticket.get("idempotencyKey"))
    }
    candidates: list[tuple[tuple[Decimal, Decimal, int, int, Decimal], dict[str, Any]]] = []
    blocked_count = 0
    no_trade_count = 0
    for index, result in enumerate(results, start=1):
        if not isinstance(result, dict):
            continue
        candidate = actionable_candidate_for_result(
            cycle=cycle,
            index=index,
            result=result,
            tickets_by_idempotency_key=tickets_by_idempotency_key,
            account=account,
        )
        if candidate is not None:
            candidates.append((candidate_score(result), candidate))
            continue
        reason = result_no_trade_reason(
            result,
            setup_grade(result.get("setup_grade") or result.get("setupGrade")),
            setup_type(result.get("setup_type") or result.get("setupType")),
            account=account,
        )
        if is_scanner_no_trade_result(result):
            no_trade_count += 1
        elif reason:
            blocked_count += 1
        else:
            no_trade_count += 1
    candidates.sort(key=lambda item: item[0], reverse=True)
    actionable_candidates = [candidate for _, candidate in candidates]
    best_candidate = actionable_candidates[0] if actionable_candidates else None
    if best_candidate is None:
        return {
            "action": "no_actionable_candidate",
            "reason": "scanner_returned_no_strategy_guard_candidate",
            "actionableCandidateCount": 0,
            "blockedResultCount": blocked_count,
            "noTradeResultCount": no_trade_count,
            "bestCandidate": None,
            "candidateSymbols": [],
        }
    return {
        "action": "run_strategy_order_guard",
        "reason": "best_candidate_ready_for_strategy_guard",
        "actionableCandidateCount": len(actionable_candidates),
        "blockedResultCount": blocked_count,
        "noTradeResultCount": no_trade_count,
        "bestCandidate": best_candidate,
        "candidateSymbols": [candidate["symbol"] for candidate in actionable_candidates[:10]],
    }


def run_cycle(args: argparse.Namespace) -> dict[str, Any]:
    cycle_started_at = time.monotonic()
    stage_timings: dict[str, Any] = {}
    symbols = normalize_watchlist(args.watchlist)
    work_dir = Path(args.work_dir or os.environ.get("AUTONOMOUS_TRADER_WORK_DIR", "/tmp/autonomous-trader-work"))
    cycle = args.cycle if args.cycle is not None else next_cycle_number(work_dir)
    cycle_dir = work_dir / f"cycle-{cycle}"
    cycle_dir.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC)
    end = args.end or now.isoformat().replace("+00:00", "Z")
    start = args.start or market_open_start(now)
    alpaca = AlpacaRestClient(timeout_seconds=args.timeout_seconds)
    synthesis = SynthesisClient(base_url=args.synthesis_base_url, timeout_seconds=args.timeout_seconds)
    broker_state: dict[str, Any] | None = None
    gate: dict[str, Any] | None = None
    recorded_account_gate: dict[str, Any] | None = None
    if args.respect_account_gate:
        account_gate_started_at = time.monotonic()
        broker_state, broker_metrics = fetch_broker_state_with_metrics(alpaca)
        stage_timings["brokerStateMs"] = broker_metrics["totalMs"]
        stage_timings["brokerState"] = broker_metrics
        gate = summarize_broker_state(broker_state)
        if args.session_id:
            recorded_account_gate = record_account_gate(
                synthesis=synthesis,
                session_id=args.session_id,
                cycle=cycle,
                gate=gate,
            )
        stage_timings["accountGateMs"] = elapsed_ms(account_gate_started_at)
        if gate.get("skipFullScan"):
            prune_started_at = time.monotonic()
            removed_cycle_dirs = prune_old_cycle_dirs(work_dir, args.retain_cycles)
            stage_timings["pruneOldCyclesMs"] = elapsed_ms(prune_started_at)
            stage_timings["totalMs"] = elapsed_ms(cycle_started_at)
            return {
                "ok": True,
                "mode": "cycle",
                "cycle": cycle,
                "cycleDir": str(cycle_dir),
                "retainedCycles": args.retain_cycles,
                "removedCycleDirs": removed_cycle_dirs,
                "accountGate": gate,
                "recordedAccountGate": recorded_account_gate,
                "recordedTickets": [],
                "resultCount": 0,
                "topResults": [],
                "action": gate.get("action"),
                "skipFullScan": True,
                "stageTimingsMs": stage_timings,
            }
    inputs, input_fetch_metrics = fetch_scan_inputs_with_metrics(
        alpaca=alpaca,
        synthesis=synthesis,
        symbols=symbols,
        start=start,
        end=end,
        feed=args.feed,
        scorecard_limit=args.scorecard_limit,
        broker_state=broker_state,
        session_id=args.session_id,
    )
    stage_timings["inputFetchMs"] = input_fetch_metrics["totalMs"]
    stage_timings["inputFetch"] = input_fetch_metrics
    for name, payload in inputs.items():
        write_json(cycle_dir / name, payload)
    scorecard_started_at = time.monotonic()
    scorecard_readback = scorecard_readback_summary(inputs.get("scorecards.json"))
    stage_timings["scorecardReadbackSummaryMs"] = elapsed_ms(scorecard_started_at)
    recorded_scorecard_readback = None
    if args.session_id:
        record_scorecard_started_at = time.monotonic()
        recorded_scorecard_readback = record_scorecard_readback(
            synthesis=synthesis,
            session_id=args.session_id,
            cycle=cycle,
            scorecard_readback=scorecard_readback,
        )
        stage_timings["recordScorecardReadbackMs"] = elapsed_ms(record_scorecard_started_at)
    analysis_context = Path(args.analysis_context or work_dir / "analysis-context.json")
    scan_started_at = time.monotonic()
    scan = run_stock_analysis_scan(
        stock_analysis_cli=stock_analysis_cli_path(args.stock_analysis_cli),
        cycle_dir=cycle_dir,
        analysis_context_path=analysis_context,
        watchlist=symbols,
    )
    scan = overlay_scorecards_on_scan(scan, inputs.get("scorecards.json"))
    scan = overlay_current_session_loss_lockout(scan, inputs.get("current-session.json"))
    stage_timings["stockAnalysisScanMs"] = elapsed_ms(scan_started_at)
    prune_started_at = time.monotonic()
    removed_cycle_dirs = prune_old_cycle_dirs(work_dir, args.retain_cycles)
    stage_timings["pruneOldCyclesMs"] = elapsed_ms(prune_started_at)
    summary = summarize_scan(
        cycle,
        cycle_dir,
        scan,
        symbols,
        retained_cycles=args.retain_cycles,
        removed_cycle_dirs=removed_cycle_dirs,
    )
    summary["scorecardReadback"] = scorecard_readback
    summary["recordedScorecardReadback"] = recorded_scorecard_readback
    account_payload = inputs.get("account.json") if isinstance(inputs.get("account.json"), dict) else None
    recorded_tickets: list[dict[str, Any]] = []
    if args.record_tickets:
        record_tickets_started_at = time.monotonic()
        recorded_tickets = record_scan_tickets(
            synthesis=synthesis,
            session_id=args.session_id or "",
            cycle=cycle,
            scan=scan,
            limit=args.max_recorded_tickets,
            account=account_payload,
        )
        summary["recordedTickets"] = recorded_tickets
        stage_timings["recordTicketsMs"] = elapsed_ms(record_tickets_started_at)
    else:
        summary["recordedTickets"] = recorded_tickets
    summary["decisionSummary"] = decision_summary_for_scan(
        cycle=cycle,
        scan=scan,
        recorded_tickets=recorded_tickets,
        account=account_payload,
    )
    if gate is not None:
        summary["accountGate"] = gate
        summary["recordedAccountGate"] = recorded_account_gate
        summary["action"] = gate.get("action")
        summary["skipFullScan"] = False
    stage_timings["totalMs"] = elapsed_ms(cycle_started_at)
    summary["stageTimingsMs"] = stage_timings
    return summary


def run_account_gate(args: argparse.Namespace) -> dict[str, Any]:
    started_at = time.monotonic()
    alpaca = AlpacaRestClient(timeout_seconds=args.timeout_seconds)
    broker_state, broker_metrics = fetch_broker_state_with_metrics(alpaca)
    summary = summarize_broker_state(broker_state)
    summary["stageTimingsMs"] = {
        "brokerStateMs": broker_metrics["totalMs"],
        "brokerState": broker_metrics,
        "totalMs": elapsed_ms(started_at),
    }
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run one autonomous-trader live scan cycle.")
    parser.add_argument("--work-dir")
    parser.add_argument("--cycle", type=int)
    parser.add_argument("--watchlist", action="append", default=[])
    parser.add_argument("--start")
    parser.add_argument("--end")
    parser.add_argument("--feed", default="iex")
    parser.add_argument("--scorecard-limit", type=int, default=20)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--synthesis-base-url")
    parser.add_argument("--analysis-context")
    parser.add_argument("--stock-analysis-cli")
    parser.add_argument("--retain-cycles", type=int, default=5)
    parser.add_argument("--session-id")
    parser.add_argument("--record-tickets", action="store_true")
    parser.add_argument("--respect-account-gate", action="store_true")
    parser.add_argument("--max-recorded-tickets", type=int, default=10)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--account-gate-only", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        payload = {
            "ok": True,
            "accountGateOnly": True,
            "recordTickets": True,
            "respectAccountGate": True,
            "defaultWatchlist": list(DEFAULT_WATCHLIST),
            "stockAnalysisCli": stock_analysis_cli_path(args.stock_analysis_cli),
        }
        print(json.dumps(payload, sort_keys=True, indent=2))
        return 0
    if args.account_gate_only:
        print(json.dumps(run_account_gate(args), sort_keys=True, indent=2))
        return 0
    print(json.dumps(run_cycle(args), sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
