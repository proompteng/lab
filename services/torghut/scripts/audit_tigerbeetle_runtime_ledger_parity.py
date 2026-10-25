#!/usr/bin/env python3
"""Emit read-only TigerBeetle/runtime-ledger parity diagnostics as stable JSON."""

from __future__ import annotations

import argparse
import json
import os
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import Settings
from app.trading.tigerbeetle_client import create_tigerbeetle_client
from app.trading.tigerbeetle_runtime_ledger_parity import (
    audit_tigerbeetle_runtime_ledger_parity,
)


def _sqlalchemy_dsn(dsn: str) -> str:
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _parse_require(value: str) -> bool | None:
    normalized = value.strip().lower()
    if normalized == "auto":
        return None
    if normalized in {"1", "true", "yes", "required"}:
        return True
    if normalized in {"0", "false", "no", "optional"}:
        return False
    raise argparse.ArgumentTypeError("expected auto, true, or false")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compare Torghut execution economics/runtime-ledger rows against "
            "TigerBeetle reference rows and optional live TigerBeetle lookups."
        )
    )
    parser.add_argument("--dsn-env", default="DB_DSN")
    parser.add_argument("--account-label", default=None)
    parser.add_argument("--limit", type=int, default=500)
    parser.add_argument(
        "--require-tigerbeetle",
        type=_parse_require,
        default=None,
        help="auto (settings), true, or false. Only required mode exits fail-closed.",
    )
    parser.add_argument(
        "--lookup-tigerbeetle",
        action="store_true",
        help="Read live TigerBeetle transfer state for refs found in Postgres.",
    )
    parser.add_argument(
        "--fail-on-required-blockers",
        action="store_true",
        help="Exit non-zero only when parity is required and blockers are present.",
    )
    return parser.parse_args()


def run_audit(args: argparse.Namespace) -> dict[str, Any]:
    dsn = os.environ.get(str(args.dsn_env).strip())
    if not dsn:
        raise SystemExit(f"missing DSN env var: {args.dsn_env}")
    settings_obj = Settings(DB_DSN=dsn)
    engine = create_engine(_sqlalchemy_dsn(dsn), pool_pre_ping=True, future=True)
    session_factory = sessionmaker(
        bind=engine,
        autoflush=False,
        autocommit=False,
        expire_on_commit=False,
        future=True,
    )
    client = (
        create_tigerbeetle_client(settings_obj) if args.lookup_tigerbeetle else None
    )
    try:
        with session_factory() as session:
            return audit_tigerbeetle_runtime_ledger_parity(
                session,
                settings_obj=settings_obj,
                client=client,
                account_label=args.account_label,
                limit=args.limit,
                require_tigerbeetle=args.require_tigerbeetle,
            )
    finally:
        if client is not None:
            close = getattr(client, "close", None)
            if callable(close):
                close()


def main() -> int:
    args = _parse_args()
    payload = run_audit(args)
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    if (
        args.fail_on_required_blockers
        and bool(payload.get("required"))
        and payload.get("blockers")
    ):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
