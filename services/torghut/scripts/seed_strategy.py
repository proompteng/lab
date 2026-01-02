#!/usr/bin/env python
"""Seed or update torghut trading strategies."""

from __future__ import annotations

import argparse
from decimal import Decimal
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import settings
from app.db import SessionLocal, ensure_schema
from app.models import Strategy


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Seed or update torghut strategies.")
    parser.add_argument("--name", required=True, help="Strategy name (unique key).")
    parser.add_argument("--description", default="MACD/RSI demo strategy", help="Strategy description.")
    parser.add_argument("--base-timeframe", default="1Min", help="Base timeframe (e.g., 1Min, 5Min).")
    parser.add_argument("--symbols", default="AAPL,MSFT", help="Comma-separated symbol list.")
    parser.add_argument("--enabled", action="store_true", help="Enable the strategy.")
    parser.add_argument("--disabled", action="store_true", help="Disable the strategy.")
    parser.add_argument("--max-notional", default=None, help="Max notional per trade (optional).")
    parser.add_argument("--max-position-pct", default=None, help="Max position pct of equity (optional).")
    return parser.parse_args()


def upsert_strategy(
    name: str,
    description: str,
    base_timeframe: str,
    symbols: list[str],
    enabled: bool,
    max_notional: Optional[str],
    max_position_pct: Optional[str],
    session: Session | None = None,
) -> Strategy:
    ensure_schema()
    owns_session = session is None
    session = session or SessionLocal()
    try:
        stmt = select(Strategy).where(Strategy.name == name)
        strategy = session.execute(stmt).scalar_one_or_none()
        if strategy is None:
            strategy = Strategy(
                name=name,
                description=description,
                enabled=enabled,
                base_timeframe=base_timeframe,
                universe_type="static",
                universe_symbols=symbols,
            )
        else:
            strategy.description = description
            strategy.enabled = enabled
            strategy.base_timeframe = base_timeframe
            strategy.universe_type = "static"
            strategy.universe_symbols = symbols

        if max_notional:
            strategy.max_notional_per_trade = Decimal(max_notional)
        if max_position_pct:
            strategy.max_position_pct_equity = Decimal(max_position_pct)

        session.add(strategy)
        session.commit()
        session.refresh(strategy)
        return strategy
    finally:
        if owns_session:
            session.close()


def main() -> None:
    args = parse_args()
    enabled = args.enabled
    if args.disabled:
        enabled = False
    symbols = [symbol.strip() for symbol in args.symbols.split(",") if symbol.strip()]
    strategy = upsert_strategy(
        name=args.name,
        description=args.description,
        base_timeframe=args.base_timeframe,
        symbols=symbols,
        enabled=enabled,
        max_notional=args.max_notional,
        max_position_pct=args.max_position_pct,
    )
    print(
        f"seeded strategy name={strategy.name} enabled={strategy.enabled} "
        f"timeframe={strategy.base_timeframe} symbols={strategy.universe_symbols} "
        f"db={settings.db_dsn}"
    )


if __name__ == "__main__":
    main()
