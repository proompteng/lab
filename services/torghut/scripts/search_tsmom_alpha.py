#!/usr/bin/env python3
"""Grid-search a TSMOM strategy and validate out-of-sample profitability.

Example:
  uv run python scripts/search_tsmom_alpha.py \
    --symbols spy.us,qqq.us,tlt.us,ief.us \
    --start 2010-01-01 --train-end 2019-12-31 --end 2025-12-31 \
    --lookbacks 20,40,60,120 --vol-lookbacks 10,20,40 \
    --target-vols 0.0075,0.01,0.0125 --max-grosses 0.75,1.0 \
    --cost-bps 5
"""

from __future__ import annotations

import argparse
import json
from datetime import date
from typing import Iterable, Optional

import pandas as pd

from app.trading.alpha.data_sources import fetch_stooq_daily
from app.trading.alpha.search import candidate_to_jsonable, run_tsmom_grid_search


def _parse_date(value: str) -> date:
    return date.fromisoformat(value)


def _parse_ints(raw: str) -> list[int]:
    values = [int(item.strip()) for item in raw.split(',') if item.strip()]
    if not values:
        raise ValueError('expected at least one integer')
    return values


def _parse_floats(raw: str) -> list[float]:
    values = [float(item.strip()) for item in raw.split(',') if item.strip()]
    if not values:
        raise ValueError('expected at least one float')
    return values


def _load_price_matrix(symbols: Iterable[str], *, start: Optional[date], end: Optional[date]) -> pd.DataFrame:
    closes: dict[str, pd.Series] = {}
    for symbol in symbols:
        bars = fetch_stooq_daily(symbol, start=start, end=end)
        closes[symbol] = bars.close.rename(symbol)
    return pd.concat(closes.values(), axis=1).dropna(how='all')


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Search TSMOM parameters and validate out-of-sample profitability.')
    parser.add_argument('--symbols', required=True, help='Comma-separated Stooq symbols (example: spy.us,qqq.us)')
    parser.add_argument('--start', required=True, help='Dataset start date (YYYY-MM-DD)')
    parser.add_argument('--train-end', required=True, help='Train split end date (YYYY-MM-DD, inclusive)')
    parser.add_argument('--end', required=True, help='Dataset end date (YYYY-MM-DD)')
    parser.add_argument('--lookbacks', default='20,40,60,120', help='Comma-separated lookback day values')
    parser.add_argument('--vol-lookbacks', default='10,20,40', help='Comma-separated vol lookback day values')
    parser.add_argument('--target-vols', default='0.0075,0.01,0.0125', help='Comma-separated target daily vols')
    parser.add_argument('--max-grosses', default='0.75,1.0', help='Comma-separated max gross leverage values')
    parser.add_argument('--cost-bps', type=float, default=5.0, help='Cost bps per unit turnover')
    parser.add_argument('--allow-shorts', action='store_true', help='Allow short exposures')
    parser.add_argument('--top-n', type=int, default=10, help='How many top candidates to output')
    parser.add_argument('--json', default=None, help='Optional output JSON file path')
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    symbols = [item.strip() for item in args.symbols.split(',') if item.strip()]
    if not symbols:
        raise ValueError('no symbols provided')

    start = _parse_date(args.start)
    train_end = _parse_date(args.train_end)
    end = _parse_date(args.end)
    if not (start < train_end < end):
        raise ValueError('expected start < train-end < end')

    prices = _load_price_matrix(symbols, start=start, end=end)
    train = prices[prices.index.date <= train_end]
    test = prices[prices.index.date > train_end]
    if train.empty or test.empty:
        raise ValueError('train/test split produced empty dataset')

    result = run_tsmom_grid_search(
        train,
        test,
        lookback_days=_parse_ints(args.lookbacks),
        vol_lookback_days=_parse_ints(args.vol_lookbacks),
        target_daily_vols=_parse_floats(args.target_vols),
        max_gross_leverages=_parse_floats(args.max_grosses),
        long_only=not args.allow_shorts,
        cost_bps_per_turnover=float(args.cost_bps),
    )

    top_n = max(1, int(args.top_n))
    payload = {
        'accepted': result.accepted,
        'reason': result.reason,
        'symbols': symbols,
        'dataset': {
            'start': start.isoformat(),
            'train_end': train_end.isoformat(),
            'end': end.isoformat(),
            'rows': int(len(prices)),
            'train_rows': int(len(train)),
            'test_rows': int(len(test)),
        },
        'search_space': {
            'lookbacks': _parse_ints(args.lookbacks),
            'vol_lookbacks': _parse_ints(args.vol_lookbacks),
            'target_vols': _parse_floats(args.target_vols),
            'max_grosses': _parse_floats(args.max_grosses),
            'cost_bps': float(args.cost_bps),
            'long_only': not args.allow_shorts,
        },
        'best': candidate_to_jsonable(result.best),
        'top': [candidate_to_jsonable(item) for item in result.candidates[:top_n]],
    }

    print(json.dumps(payload, indent=2, sort_keys=True))

    if args.json:
        with open(args.json, 'w', encoding='utf-8') as f:
            json.dump(payload, f, indent=2, sort_keys=True)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())

