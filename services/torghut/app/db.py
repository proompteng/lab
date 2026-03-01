"""Database utilities for torghut."""

from collections.abc import Generator
from pathlib import Path
from typing import Any, Optional

from alembic.config import Config as AlembicConfig
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import (
    Column,
    Integer,
    MetaData,
    String,
    Table,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base

_APP_ROOT = Path(__file__).resolve().parent.parent
_ALEMBIC_INI_PATH = _APP_ROOT / "alembic.ini"
_ALEMBIC_MIGRATIONS_PATH = _APP_ROOT / "migrations"

engine: Engine = create_engine(
    settings.sqlalchemy_dsn,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=5,
    future=True,
)
SessionLocal = sessionmaker(
    bind=engine,
    autocommit=False,
    autoflush=False,
    expire_on_commit=False,
    future=True,
)

# Simple metadata table to confirm connectivity and seed future migrations.
metadata = MetaData()
torghut_meta = Table(
    "torghut_meta",
    metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("key", String(length=64), nullable=False, unique=True),
    Column("value", String(length=255), nullable=False),
)


def get_session() -> Generator[Session, None, None]:
    """Provide a SQLAlchemy session for FastAPI dependencies."""

    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _normalize_name(value: object) -> str:
    return str(value).strip().lower()


def _column_set(inspector: Any, table: str) -> set[str]:
    return {_normalize_name(column["name"]) for column in inspector.get_columns(table)}


def _index_names(inspector: Any, table: str) -> set[str]:
    return {
        _normalize_name(index["name"])
        for index in inspector.get_indexes(table)
        if index.get("name") is not None
    }


def _has_columns(inspector: Any, table: str, columns: list[str]) -> bool:
    columns_present = _column_set(inspector, table)
    return all(_normalize_name(column) in columns_present for column in columns)


def _has_unique_index(inspector: Any, table: str, columns: list[str]) -> bool:
    expected = {_normalize_name(col) for col in columns}
    indexes = inspector.get_indexes(table)
    for index in indexes:
        if not index.get("unique"):
            continue
        index_columns = [_normalize_name(col) for col in index.get("column_names", [])]
        if set(index_columns) == expected:
            return True

    constraints = inspector.get_unique_constraints(table)
    for constraint in constraints:
        constraint_columns = [
            _normalize_name(column)
            for column in constraint.get("column_names", [])
        ]
        if set(constraint_columns) == expected:
            return True
    return False


def _named_unique_constraint_present(
    inspector: Any, table: str, names: set[str]
) -> bool:
    constraint_names = {
        _normalize_name(constraint.get("name")) for constraint in inspector.get_unique_constraints(table)
    }
    return any(name in constraint_names for name in names)


def check_account_scope_invariants(session: Session) -> dict[str, object]:
    """Validate schema constraints required for account-scoped trading isolation."""

    inspector = inspect(session.bind)
    checks: dict[str, object] = {}
    errors: list[str] = []

    required_checks = {
        "executions_have_account_label": (
            "executions",
            ["alpaca_account_label"],
        ),
        "trade_decisions_have_account_label": (
            "trade_decisions",
            ["alpaca_account_label"],
        ),
        "trade_cursor_has_account_label": ("trade_cursor", ["account_label"]),
        "execution_order_events_have_account_label": (
            "execution_order_events",
            ["alpaca_account_label"],
        ),
    }

    for key, (table, required_columns) in required_checks.items():
        ok = _has_columns(inspector, table, required_columns)
        checks[key] = ok
        if not ok:
            errors.append(f"{table} missing required columns: {required_columns}")

    checks["execution_has_account_scoped_unique_order_id"] = _has_unique_index(
        inspector,
        "executions",
        ["alpaca_account_label", "alpaca_order_id"],
    )
    if not checks["execution_has_account_scoped_unique_order_id"]:
        errors.append(
            "executions missing unique index on (alpaca_account_label, alpaca_order_id)"
        )

    checks["execution_has_account_scoped_unique_client_order_id"] = _has_unique_index(
        inspector,
        "executions",
        ["alpaca_account_label", "client_order_id"],
    )
    if not checks["execution_has_account_scoped_unique_client_order_id"]:
        errors.append(
            "executions missing unique index on (alpaca_account_label, client_order_id)"
        )

    checks["trade_decision_has_account_scoped_unique_decision_hash"] = (
        _has_unique_index(
            inspector,
            "trade_decisions",
            ["alpaca_account_label", "decision_hash"],
        )
    )
    if not checks["trade_decision_has_account_scoped_unique_decision_hash"]:
        errors.append(
            "trade_decisions missing unique index on "
            "(alpaca_account_label, decision_hash)"
        )

    checks["trade_cursor_has_account_scoped_source_index"] = _has_unique_index(
        inspector,
        "trade_cursor",
        ["source", "account_label"],
    )
    if not checks["trade_cursor_has_account_scoped_source_index"]:
        errors.append(
            "trade_cursor missing unique index on (source, account_label)"
        )

    checks["legacy_executions_single_account_order_id_index_detected"] = (
        _has_unique_index(
            inspector,
            "executions",
            ["alpaca_order_id"],
        )
        or _named_unique_constraint_present(
            inspector,
            "executions",
            {"executions_alpaca_order_id_key"},
        )
    )
    if checks["legacy_executions_single_account_order_id_index_detected"]:
        errors.append(
            "legacy unique constraint/index detected for executions.alpaca_order_id"
        )

    checks["legacy_executions_single_account_client_order_id_index_detected"] = (
        _has_unique_index(inspector, "executions", ["client_order_id"])
        or _named_unique_constraint_present(
            inspector,
            "executions",
            {"executions_client_order_id_key"},
        )
    )
    if checks["legacy_executions_single_account_client_order_id_index_detected"]:
        errors.append(
            "legacy unique constraint/index detected for executions.client_order_id"
        )

    checks["legacy_trade_cursor_source_only_source_index_detected"] = (
        _has_unique_index(inspector, "trade_cursor", ["source"])
        or _named_unique_constraint_present(
            inspector,
            "trade_cursor",
            {"trade_cursor_source_key"},
        )
    )
    if checks["legacy_trade_cursor_source_only_source_index_detected"]:
        errors.append(
            "legacy unique constraint/index detected for trade_cursor.source"
        )

    checks["legacy_executions_single_account_indexes_present"] = (
        checks["legacy_executions_single_account_order_id_index_detected"]
        or checks["legacy_executions_single_account_client_order_id_index_detected"]
    )
    checks["legacy_trade_cursor_source_only_index_present"] = (
        checks["legacy_trade_cursor_source_only_source_index_detected"]
    )
    checks["account_scope_ready"] = not errors
    checks["account_scope_index_names"] = {
        "execution_indexes": sorted(_index_names(inspector, "executions")),
        "trade_decision_indexes": sorted(_index_names(inspector, "trade_decisions")),
        "trade_cursor_indexes": sorted(_index_names(inspector, "trade_cursor")),
    }
    checks["account_scope_errors"] = errors

    if errors and not settings.trading_multi_account_enabled:
        checks["account_scope_ready"] = True
        checks["account_scope_errors"] = []
    return checks


def ensure_schema() -> None:
    """Create minimal schema if the database is reachable."""

    metadata.create_all(bind=engine, checkfirst=True)
    Base.metadata.create_all(bind=engine, checkfirst=True)


def ping(session: Session) -> Optional[int]:
    """Run a lightweight SELECT 1 for health checks."""

    result = session.execute(text("SELECT 1"))
    first = result.scalar_one()
    return int(first) if first is not None else None


def _alembic_config() -> AlembicConfig:
    if not _ALEMBIC_INI_PATH.exists():
        raise RuntimeError(f"Alembic config not found at {_ALEMBIC_INI_PATH}")
    if not _ALEMBIC_MIGRATIONS_PATH.exists():
        raise RuntimeError(f"Alembic migrations directory not found at {_ALEMBIC_MIGRATIONS_PATH}")
    config = AlembicConfig(str(_ALEMBIC_INI_PATH))
    config.set_main_option("script_location", str(_ALEMBIC_MIGRATIONS_PATH))
    config.set_main_option("sqlalchemy.url", settings.sqlalchemy_dsn)
    return config


def check_schema_current(session: Session) -> dict[str, object]:
    """Report Alembic head alignment for readiness and diagnostics."""

    ping(session)
    expected_heads = set(ScriptDirectory.from_config(_alembic_config()).get_heads())
    context = MigrationContext.configure(connection=session.connection())
    current_heads = set(context.get_current_heads())
    return {
        "schema_current": current_heads == expected_heads,
        "current_heads": sorted(current_heads),
        "expected_heads": sorted(expected_heads),
    }
