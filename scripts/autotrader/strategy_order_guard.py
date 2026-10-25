#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from typing import Any

from live_scan_cycle import AlpacaRestClient


def parse_price(value: str | float | int, field: str) -> float:
    try:
        price = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{field} must be numeric") from error
    if price <= 0:
        raise ValueError(f"{field} must be positive")
    return price


def latest_quote_prices(payload: dict[str, Any], symbol: str) -> tuple[float | None, float | None]:
    quotes = payload.get("quotes")
    quote = quotes.get(symbol.upper()) if isinstance(quotes, dict) else None
    if not isinstance(quote, dict):
        return None, None
    return optional_price(quote.get("bp") or quote.get("bid")), optional_price(quote.get("ap") or quote.get("ask"))


def latest_trade_price(payload: dict[str, Any], symbol: str) -> float | None:
    trades = payload.get("trades")
    trade = trades.get(symbol.upper()) if isinstance(trades, dict) else None
    if not isinstance(trade, dict):
        return None
    return optional_price(trade.get("p") or trade.get("price"))


def optional_price(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        price = float(value)
    except (TypeError, ValueError):
        return None
    return price if price > 0 else None


def spread_pct(bid: float | None, ask: float | None) -> float | None:
    if bid is None or ask is None or bid <= 0 or ask <= 0 or ask < bid:
        return None
    midpoint = (bid + ask) / 2
    return ((ask - bid) / midpoint) * 100


def decide_strategy_order(
    *,
    symbol: str,
    side: str,
    entry_limit: float,
    take_profit_limit: float,
    stop_loss_stop: float,
    latest_bid: float | None,
    latest_ask: float | None,
    latest_trade: float | None,
    max_spread_pct: float,
    min_target_headroom_pct: float,
) -> dict[str, Any]:
    side = side.lower()
    if side not in {"buy", "sell"}:
        raise ValueError("side must be buy or sell")
    if side == "buy" and not (take_profit_limit > entry_limit > stop_loss_stop):
        return block("invalid_buy_bracket_prices")
    if side == "sell" and not (take_profit_limit < entry_limit < stop_loss_stop):
        return block("invalid_sell_bracket_prices")

    observed_spread_pct = spread_pct(latest_bid, latest_ask)
    if observed_spread_pct is None:
        return block("missing_or_invalid_quote")
    if observed_spread_pct > max_spread_pct:
        return block("spread_too_wide", spreadPct=observed_spread_pct)
    if latest_trade is None:
        return block("missing_latest_trade", spreadPct=observed_spread_pct)

    if side == "buy":
        market_entry = latest_ask
        if market_entry is None:
            return block("missing_latest_ask", spreadPct=observed_spread_pct)
        if latest_trade >= take_profit_limit or market_entry >= take_profit_limit:
            return block("target_already_touched", spreadPct=observed_spread_pct)
        if latest_trade <= stop_loss_stop:
            return block("stop_already_touched", spreadPct=observed_spread_pct)
        target_headroom_pct = ((take_profit_limit - market_entry) / market_entry) * 100
        if target_headroom_pct < min_target_headroom_pct:
            return block(
                "target_headroom_too_small",
                spreadPct=observed_spread_pct,
                targetHeadroomPct=target_headroom_pct,
            )
    else:
        market_entry = latest_bid
        if market_entry is None:
            return block("missing_latest_bid", spreadPct=observed_spread_pct)
        if latest_trade <= take_profit_limit or market_entry <= take_profit_limit:
            return block("target_already_touched", spreadPct=observed_spread_pct)
        if latest_trade >= stop_loss_stop:
            return block("stop_already_touched", spreadPct=observed_spread_pct)
        target_headroom_pct = ((market_entry - take_profit_limit) / market_entry) * 100
        if target_headroom_pct < min_target_headroom_pct:
            return block(
                "target_headroom_too_small",
                spreadPct=observed_spread_pct,
                targetHeadroomPct=target_headroom_pct,
            )

    return {
        "allowed": True,
        "reason": "fresh_strategy_order",
        "spreadPct": observed_spread_pct,
        "targetHeadroomPct": target_headroom_pct,
    }


def block(reason: str, **extra: Any) -> dict[str, Any]:
    return {"allowed": False, "reason": reason, **extra}


def evaluate_order(args: argparse.Namespace) -> dict[str, Any]:
    symbol = args.symbol.upper()
    alpaca = AlpacaRestClient(timeout_seconds=args.timeout_seconds)
    quote_payload = alpaca.data_get("/stocks/quotes/latest", {"symbols": symbol, "feed": args.feed})
    trade_payload = alpaca.data_get("/stocks/trades/latest", {"symbols": symbol, "feed": args.feed})
    latest_bid, latest_ask = latest_quote_prices(quote_payload, symbol)
    latest_trade = latest_trade_price(trade_payload, symbol)
    decision = decide_strategy_order(
        symbol=symbol,
        side=args.side,
        entry_limit=parse_price(args.entry_limit, "entry_limit"),
        take_profit_limit=parse_price(args.take_profit_limit, "take_profit_limit"),
        stop_loss_stop=parse_price(args.stop_loss_stop, "stop_loss_stop"),
        latest_bid=latest_bid,
        latest_ask=latest_ask,
        latest_trade=latest_trade,
        max_spread_pct=args.max_spread_pct,
        min_target_headroom_pct=args.min_target_headroom_pct,
    )
    return {
        "ok": True,
        "symbol": symbol,
        "side": args.side,
        "entryLimit": args.entry_limit,
        "takeProfitLimit": args.take_profit_limit,
        "stopLossStop": args.stop_loss_stop,
        "latestBid": latest_bid,
        "latestAsk": latest_ask,
        "latestTrade": latest_trade,
        **decision,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Guard one planned autotrader strategy order before broker submit.")
    parser.add_argument("--symbol")
    parser.add_argument("--side", choices=("buy", "sell"))
    parser.add_argument("--entry-limit")
    parser.add_argument("--take-profit-limit")
    parser.add_argument("--stop-loss-stop")
    parser.add_argument("--feed", default="iex")
    parser.add_argument("--max-spread-pct", type=float, default=0.35)
    parser.add_argument("--min-target-headroom-pct", type=float, default=0.25)
    parser.add_argument("--timeout-seconds", type=float, default=10.0)
    parser.add_argument("--self-test", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.self_test:
        allowed = decide_strategy_order(
            symbol="NVDA",
            side="buy",
            entry_limit=229.20,
            take_profit_limit=231.80,
            stop_loss_stop=227.90,
            latest_bid=229.15,
            latest_ask=229.20,
            latest_trade=229.18,
            max_spread_pct=0.35,
            min_target_headroom_pct=0.25,
        )
        stale = decide_strategy_order(
            symbol="NVDA",
            side="buy",
            entry_limit=229.20,
            take_profit_limit=231.80,
            stop_loss_stop=227.90,
            latest_bid=231.00,
            latest_ask=231.44,
            latest_trade=231.04,
            max_spread_pct=0.35,
            min_target_headroom_pct=0.25,
        )
        payload = {
            "ok": allowed["allowed"] is True and stale["allowed"] is False,
            "allowed": allowed,
            "stale": stale,
        }
        print(json.dumps(payload, sort_keys=True, indent=2))
        return 0
    required = ("symbol", "side", "entry_limit", "take_profit_limit", "stop_loss_stop")
    missing = [name.replace("_", "-") for name in required if getattr(args, name) is None]
    if missing:
        raise SystemExit(f"missing required arguments: {', '.join(missing)}")
    print(json.dumps(evaluate_order(args), sort_keys=True, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
