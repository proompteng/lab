#!/usr/bin/env python3
"""Run a minimal walk-forward evaluation over fixture signals."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import yaml

from app.models import Strategy
from app.trading.decisions import DecisionEngine
from app.trading.evaluation import (
    FixtureSignalSource,
    generate_walk_forward_folds,
    run_walk_forward,
    write_walk_forward_results,
)


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _load_strategy_config(path: Path) -> list[Strategy]:
    raw = path.read_text(encoding="utf-8")
    suffix = path.suffix.lower()
    if suffix in {".yaml", ".yml"}:
        payload = yaml.safe_load(raw)
    elif suffix == ".json":
        payload = json.loads(raw)
    else:
        raise ValueError(f"Unsupported strategy config extension: {suffix}")

    if isinstance(payload, dict):
        payload = payload.get("strategies", payload)
    if not isinstance(payload, list):
        raise ValueError("Strategy config must be a list or include a strategies key")

    strategies: list[Strategy] = []
    for item in payload:
        if not isinstance(item, dict):
            raise ValueError("Strategy entry must be an object")
        strategies.append(_strategy_from_dict(item))
    return strategies


def _strategy_from_dict(item: dict[str, Any]) -> Strategy:
    return Strategy(
        name=str(item.get("name", "walkforward")),
        description=item.get("description"),
        enabled=bool(item.get("enabled", True)),
        base_timeframe=str(item.get("base_timeframe", "1Min")),
        universe_type=str(item.get("universe_type", "static")),
        universe_symbols=item.get("universe_symbols") or item.get("symbols"),
        max_position_pct_equity=item.get("max_position_pct_equity"),
        max_notional_per_trade=item.get("max_notional_per_trade"),
    )


def _default_strategy(timeframe: str) -> list[Strategy]:
    return [
        Strategy(
            name="walkforward-default",
            description="Default walk-forward strategy",
            enabled=True,
            base_timeframe=timeframe,
            universe_type="static",
            universe_symbols=None,
            max_position_pct_equity=None,
            max_notional_per_trade=None,
        )
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run walk-forward evaluation on fixture signals.")
    parser.add_argument("--signals", type=Path, required=True, help="Path to fixture signal JSON.")
    parser.add_argument("--output", type=Path, required=True, help="Path to write results JSON.")
    parser.add_argument("--start", type=str, required=True, help="Start datetime (ISO).")
    parser.add_argument("--end", type=str, required=True, help="End datetime (ISO).")
    parser.add_argument("--train-window-minutes", type=int, default=60, help="Train window size in minutes.")
    parser.add_argument("--test-window-minutes", type=int, default=30, help="Test window size in minutes.")
    parser.add_argument("--step-minutes", type=int, default=30, help="Step size in minutes.")
    parser.add_argument("--strategy-config", type=Path, help="Optional strategy config (YAML/JSON).")
    parser.add_argument("--strategy-timeframe", type=str, default="1Min", help="Timeframe for default strategy.")
    args = parser.parse_args()

    signal_source = FixtureSignalSource.from_path(args.signals)
    folds = generate_walk_forward_folds(
        _parse_datetime(args.start),
        _parse_datetime(args.end),
        train_window=timedelta(minutes=args.train_window_minutes),
        test_window=timedelta(minutes=args.test_window_minutes),
        step=timedelta(minutes=args.step_minutes),
    )

    if args.strategy_config:
        strategies = _load_strategy_config(args.strategy_config)
    else:
        strategies = _default_strategy(args.strategy_timeframe)

    results = run_walk_forward(
        folds,
        strategies=strategies,
        signal_source=signal_source,
        decision_engine=DecisionEngine(),
    )
    write_walk_forward_results(results, args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
