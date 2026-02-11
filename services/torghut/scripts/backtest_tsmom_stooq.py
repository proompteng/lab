#!/usr/bin/env python3
"""Backtest a baseline time-series momentum strategy using Stooq daily data.

Example:
  uv run python scripts/backtest_tsmom_stooq.py --symbols spy.us,qqq.us,tlt.us \\
    --start 2010-01-01 --end 2025-12-31 --lookback 60 --vol-lookback 20 --target-vol 0.01 --cost-bps 5
"""

from __future__ import annotations

import argparse
import json
from datetime import date
from typing import Optional

import pandas as pd

from app.trading.alpha.data_sources import fetch_stooq_daily
from app.trading.alpha.metrics import summarize_equity_curve, to_jsonable
from app.trading.alpha.tsmom import TSMOMConfig, backtest_tsmom


def _parse_date(value: str) -> date:
    return date.fromisoformat(value)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Backtest TSMOM baseline on Stooq daily bars.")
    parser.add_argument("--symbols", required=True, help="Comma-separated Stooq symbols, e.g. spy.us,qqq.us")
    parser.add_argument("--start", default=None, help="Start date (YYYY-MM-DD)")
    parser.add_argument("--end", default=None, help="End date (YYYY-MM-DD)")
    parser.add_argument("--lookback", type=int, default=60, help="Lookback window (days)")
    parser.add_argument("--vol-lookback", type=int, default=20, help="Volatility lookback (days)")
    parser.add_argument("--target-vol", type=float, default=0.01, help="Target daily volatility (fraction)")
    parser.add_argument("--max-gross", type=float, default=1.0, help="Max gross leverage")
    parser.add_argument("--long-only", action="store_true", help="Long-only mode (default).")
    parser.add_argument("--allow-shorts", action="store_true", help="Allow short weights.")
    parser.add_argument("--cost-bps", type=float, default=5.0, help="Cost in bps per unit turnover.")
    parser.add_argument("--json", default=None, help="Optional output JSON path.")
    parser.add_argument("--csv", default=None, help="Optional output CSV path for equity/debug.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    symbols = [s.strip() for s in str(args.symbols).split(",") if s.strip()]
    if not symbols:
        raise ValueError("no symbols provided")

    start: Optional[date] = _parse_date(args.start) if args.start else None
    end: Optional[date] = _parse_date(args.end) if args.end else None

    closes: dict[str, pd.Series] = {}
    for sym in symbols:
        bars = fetch_stooq_daily(sym, start=start, end=end)
        closes[sym] = bars.close.rename(sym)

    price_df = pd.concat(closes.values(), axis=1).dropna(how="all")
    cfg = TSMOMConfig(
        lookback_days=int(args.lookback),
        vol_lookback_days=int(args.vol_lookback),
        target_daily_vol=float(args.target_vol),
        max_gross_leverage=float(args.max_gross),
        long_only=not bool(args.allow_shorts),
        cost_bps_per_turnover=float(args.cost_bps),
        start=start,
        end=end,
    )

    equity, debug = backtest_tsmom(price_df, cfg)
    summary = summarize_equity_curve(equity)

    config_payload = {
        key: (value.isoformat() if isinstance(value, date) else value) for key, value in cfg.__dict__.items()
    }
    payload = {
        "config": config_payload,
        "summary": to_jsonable(summary),
        "equity_last": float(equity.iloc[-1]),
        "start": str(equity.index.min()),
        "end": str(equity.index.max()),
        "symbols": symbols,
    }

    print(json.dumps(payload, indent=2, sort_keys=True))

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, sort_keys=True)

    if args.csv:
        out = pd.concat([equity, debug], axis=1)
        out.to_csv(args.csv)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
