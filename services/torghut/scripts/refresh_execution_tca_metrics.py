#!/usr/bin/env python3
"""Refresh materialized execution TCA evidence for promotion gates."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker

from app.db import SessionLocal
from app.trading.tca import refresh_execution_tca_metrics


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Refresh stale execution_tca_metrics rows from persisted executions.",
    )
    parser.add_argument(
        "--dsn-env",
        default="DB_DSN",
        help="Environment variable containing the database DSN to refresh.",
    )
    parser.add_argument("--account-label", type=str, default=None)
    parser.add_argument(
        "--older-than-seconds",
        type=int,
        default=86400,
        help="Only refresh rows with computed_at older than this age. Use 0 to refresh all current rows once.",
    )
    parser.add_argument("--batch-size", type=int, default=1000)
    parser.add_argument("--max-batches", type=int, default=20)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Commit refreshed TCA rows. Default is dry-run.",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _session_factory(args: argparse.Namespace) -> tuple[Any, Engine | None]:
    dsn_env = str(args.dsn_env or "DB_DSN").strip() or "DB_DSN"
    if dsn_env == "DB_DSN":
        return SessionLocal, None

    dsn = os.environ.get(dsn_env)
    if not dsn:
        raise SystemExit(f"missing DSN env var: {dsn_env}")

    engine = create_engine(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    return (
        sessionmaker(
            bind=engine,
            autoflush=False,
            autocommit=False,
            expire_on_commit=False,
            future=True,
        ),
        engine,
    )


def _payload(
    *, args: argparse.Namespace, started_at: datetime, batches: list[dict[str, Any]]
) -> dict[str, Any]:
    selected = sum(int(batch.get("selected") or 0) for batch in batches)
    refreshed = sum(int(batch.get("refreshed") or 0) for batch in batches)
    return {
        "status": "ok",
        "apply": bool(args.apply),
        "dsn_env": args.dsn_env,
        "account_label": args.account_label,
        "older_than_seconds": max(0, int(args.older_than_seconds)),
        "batch_size": max(1, min(int(args.batch_size), 5000)),
        "max_batches": max(1, int(args.max_batches)),
        "selected": selected,
        "refreshed": refreshed,
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(timezone.utc).isoformat(),
        "batches": batches,
    }


def main() -> int:
    args = _parse_args()
    started_at = datetime.now(timezone.utc)
    stale_before = started_at - timedelta(seconds=max(0, int(args.older_than_seconds)))
    batch_size = max(1, min(int(args.batch_size), 5000))
    max_batches = max(1, int(args.max_batches))
    batches: list[dict[str, Any]] = []
    session_factory, engine = _session_factory(args)

    try:
        with session_factory() as session:
            for _ in range(max_batches):
                batch = refresh_execution_tca_metrics(
                    session,
                    account_label=args.account_label,
                    stale_before=stale_before,
                    limit=batch_size,
                    dry_run=not bool(args.apply),
                )
                batches.append(batch)
                if args.apply:
                    session.commit()
                else:
                    session.rollback()
                    break
                if int(batch.get("selected") or 0) < batch_size:
                    break
    finally:
        if engine is not None:
            engine.dispose()

    payload = _payload(args=args, started_at=started_at, batches=batches)
    print(
        json.dumps(payload, separators=(",", ":"))
        if args.json
        else json.dumps(payload, indent=2, default=str)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
