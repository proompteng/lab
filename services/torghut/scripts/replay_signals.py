#!/usr/bin/env python
"""Replay ClickHouse signals through the decision engine without executing orders."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select

from app.config import settings
from app.db import SessionLocal, ensure_schema
from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.ingest import ClickHouseSignalIngestor
from app.trading.prices import ClickHousePriceFetcher
from app.trading.risk import RiskEngine


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Replay ClickHouse signals through the decision engine.")
    parser.add_argument("--start", required=True, help="Start timestamp (ISO-8601).")
    parser.add_argument("--end", required=True, help="End timestamp (ISO-8601).")
    parser.add_argument("--symbol", default=None, help="Symbol filter (optional).")
    parser.add_argument("--limit", type=int, default=500, help="Max signals to replay.")
    parser.add_argument(
        "--apply-risk",
        action="store_true",
        help="Run risk engine evaluation (still no order execution).",
    )
    return parser.parse_args()


def parse_ts(value: str) -> datetime:
    cleaned = value.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(cleaned)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def main() -> None:
    args = parse_args()
    ensure_schema()

    with SessionLocal() as session:
        stmt = select(Strategy).where(Strategy.enabled.is_(True))
        strategies = list(session.execute(stmt).scalars().all())

    if not strategies:
        print("No enabled strategies found. Seed one before replaying.")
        return

    strategies_by_id = {str(strategy.id): strategy for strategy in strategies}
    ingestor = ClickHouseSignalIngestor()
    signals = ingestor.fetch_signals_between(
        start=parse_ts(args.start),
        end=parse_ts(args.end),
        symbol=args.symbol,
        limit=args.limit,
    )
    if not signals:
        print("No signals found for the requested window.")
        return

    price_fetcher = ClickHousePriceFetcher()
    decision_engine = DecisionEngine(price_fetcher=price_fetcher)
    risk_engine = RiskEngine()

    decisions_total = 0
    approved_total = 0
    for signal in signals:
        decisions = decision_engine.evaluate(signal, strategies)
        for decision in decisions:
            decisions_total += 1
            if args.apply_risk:
                strategy = strategies_by_id.get(decision.strategy_id)
                if strategy is None:
                    verdict_label = "strategy_missing"
                else:
                    original_enabled = settings.trading_enabled
                    settings.trading_enabled = True
                    try:
                        with SessionLocal() as session:
                            verdict = risk_engine.evaluate(
                                session,
                                decision,
                                strategy,
                                account={"equity": "10000", "buying_power": "10000"},
                                positions=[],
                                allowed_symbols=None,
                            )
                        if verdict.approved:
                            approved_total += 1
                        verdict_label = "approved" if verdict.approved else "rejected"
                    finally:
                        settings.trading_enabled = original_enabled
            else:
                verdict_label = "risk_skipped"
            print(
                f"{decision.event_ts.isoformat()} strategy={decision.strategy_id} "
                f"symbol={decision.symbol} action={decision.action} qty={decision.qty} "
                f"price={decision.params.get('price') or Decimal('0')} verdict={verdict_label}"
            )

    print(
        f"Replay complete signals={len(signals)} decisions={decisions_total} "
        f"risk_approved={approved_total if args.apply_risk else 'n/a'}"
    )


if __name__ == "__main__":
    main()
