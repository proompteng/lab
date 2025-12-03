"""SQLAlchemy base classes and shared types for torghut models."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import JSON, MetaData
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.types import CHAR, TypeDecorator
from sqlalchemy.orm import DeclarativeBase


NAMING_CONVENTION: dict[str, str] = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


metadata_obj = MetaData(naming_convention=NAMING_CONVENTION)


class Base(DeclarativeBase):
    """Declarative base for torghut ORM models."""

    metadata = metadata_obj


class GUID(TypeDecorator):
    """Platform-independent UUID type.

    Uses PostgreSQL's native UUID when available and falls back to CHAR(36)
    elsewhere so SQLite-based tests still work.
    """

    impl = CHAR(36)
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PGUUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value: Any, dialect):  # noqa: ANN401 - SQLAlchemy typing
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return str(value)
        return str(uuid.UUID(str(value)))

    def process_result_value(self, value: Any, dialect):  # noqa: ANN401 - SQLAlchemy typing
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return value
        return uuid.UUID(str(value))


class JSONType(TypeDecorator):
    """JSON column that prefers PostgreSQL JSONB but works on SQLite."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect):
        if dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import JSONB  # imported lazily to avoid hard dependency

            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())



__all__ = ["Base", "GUID", "JSONType", "metadata_obj"]
