"""CLI argument parsing for runtime window imports."""

from __future__ import annotations

import argparse
import os
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.db import SessionLocal


def _sqlalchemy_dsn(dsn: str) -> str:
    """Convert various PostgreSQL DSN formats to SQLAlchemy format."""
    text = dsn.strip()
    if text.startswith("postgresql+psycopg://"):
        return text
    if text.startswith("postgres://"):
        return text.replace("postgres://", "postgresql+psycopg://", 1)
    if text.startswith("postgresql://"):
        return text.replace("postgresql://", "postgresql+psycopg://", 1)
    return text


def _target_persistence_dsn(args: argparse.Namespace) -> str:
    """Determine the target persistence DSN from args or environment."""
    direct_dsn = str(getattr(args, "target_dsn", "") or "").strip()
    if direct_dsn:
        return direct_dsn
    target_dsn_env = str(getattr(args, "target_dsn_env", "") or "").strip()
    if not target_dsn_env:
        return ""
    dsn = os.getenv(target_dsn_env, "").strip()
    if not dsn:
        raise RuntimeError(f"target_dsn_not_configured:{target_dsn_env}")
    return dsn


@contextmanager
def _persistence_session(args: argparse.Namespace) -> Iterator[Session]:
    """Create a persistence session context manager."""
    target_dsn = _target_persistence_dsn(args)
    if not target_dsn:
        with SessionLocal() as session:
            yield session
        return
    engine = create_engine(
        _sqlalchemy_dsn(target_dsn),
        pool_pre_ping=True,
        future=True,
    )
    TargetSessionLocal = sessionmaker(
        bind=engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        with TargetSessionLocal() as session:
            yield session
    finally:
        engine.dispose()


def _parse_args() -> argparse.Namespace:
    """Parse command line arguments for runtime window import."""
    parser = argparse.ArgumentParser(
        description="Import observed runtime windows into strategy hypothesis governance tables.",
    )
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--candidate-id", default="")
    parser.add_argument("--hypothesis-id", required=True)
    parser.add_argument("--observed-stage", required=True, choices=("paper", "live"))
    parser.add_argument("--strategy-family", default="")
    parser.add_argument("--source-dsn", default="")
    parser.add_argument("--source-dsn-env", default="DB_DSN")
    parser.add_argument("--target-dsn", default="")
    parser.add_argument(
        "--target-dsn-env",
        default="",
        help=(
            "Optional environment variable for the database where imported runtime "
            "governance rows are persisted. Defaults to DB_DSN via SessionLocal."
        ),
    )
    parser.add_argument("--strategy-name", required=True)
    parser.add_argument("--account-label", required=True)
    parser.add_argument("--source-account-label", default="")
    parser.add_argument("--window-start", required=True)
    parser.add_argument("--window-end", required=True)
    parser.add_argument("--bucket-minutes", type=int, default=30)
    parser.add_argument("--sample-minutes", type=int, default=5)
    parser.add_argument("--source-manifest-ref", default="")
    parser.add_argument("--source-kind", default="")
    parser.add_argument("--dataset-snapshot-ref", default="")
    parser.add_argument("--artifact-ref", action="append", default=[])
    parser.add_argument(
        "--target-metadata-json",
        default="",
        help=(
            "JSON object copied from the candidate-board runtime-window target. "
            "Used for evidence-collection-only paper probation handoffs."
        ),
    )
    parser.add_argument("--delay-adjusted-depth-stress-report-ref", default="")
    parser.add_argument("--dependency-quorum-decision", default="")
    parser.add_argument("--continuity-ok", default="")
    parser.add_argument("--drift-ok", default="")
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help=(
            "Run source, execution, TCA, and runtime-ledger proof diagnostics "
            "without writing imported governance rows."
        ),
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()
