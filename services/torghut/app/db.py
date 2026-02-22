"""Database utilities for torghut."""

from collections.abc import Generator
from pathlib import Path
from typing import Optional

from alembic.config import Config as AlembicConfig
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine, text
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
