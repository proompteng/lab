"""Database utilities for torghut."""

from collections.abc import Generator
from typing import Optional

from sqlalchemy import Column, Integer, MetaData, String, Table, create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base

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
