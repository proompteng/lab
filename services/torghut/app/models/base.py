"""SQLAlchemy base classes and shared types for torghut models."""

from __future__ import annotations

import uuid
from typing import Any, cast

from pydantic import TypeAdapter
from sqlalchemy import JSON, MetaData
from sqlalchemy.engine import Dialect
from sqlalchemy.dialects.postgresql import UUID as PGUUID
from sqlalchemy.types import CHAR, TypeDecorator, TypeEngine
from sqlalchemy.orm import DeclarativeBase


NAMING_CONVENTION: dict[str, str] = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


metadata_obj = MetaData(naming_convention=NAMING_CONVENTION)

_JSON_ADAPTER: TypeAdapter[Any] = TypeAdapter(Any)


class Base(DeclarativeBase):
    """Declarative base for torghut ORM models."""

    metadata = metadata_obj


class GUID(TypeDecorator[uuid.UUID]):
    """Platform-independent UUID type.

    Uses PostgreSQL's native UUID when available and falls back to CHAR(36)
    elsewhere so SQLite-based tests still work.
    """

    impl = CHAR(36)
    cache_ok = True

    def load_dialect_impl(self, dialect: Dialect) -> TypeEngine[Any]:  # type: ignore[override]
        if dialect.name == "postgresql":
            return dialect.type_descriptor(PGUUID(as_uuid=True))
        return dialect.type_descriptor(CHAR(36))

    def process_bind_param(self, value: Any, dialect: Dialect) -> Any:  # noqa: ANN401 - SQLAlchemy typing
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return str(value)
        return str(uuid.UUID(str(value)))

    def process_result_value(self, value: Any, dialect: Dialect) -> Any:  # noqa: ANN401 - SQLAlchemy typing
        if value is None:
            return value
        if isinstance(value, uuid.UUID):
            return value
        return uuid.UUID(str(value))


class JSONType(TypeDecorator[Any]):
    """JSON column that prefers PostgreSQL JSONB but works on SQLite."""

    impl = JSON
    cache_ok = True

    def load_dialect_impl(self, dialect: Dialect) -> TypeEngine[Any]:  # type: ignore[override]
        if dialect.name == "postgresql":
            from sqlalchemy.dialects.postgresql import JSONB  # imported lazily to avoid hard dependency

            return dialect.type_descriptor(JSONB())
        return dialect.type_descriptor(JSON())

    def process_bind_param(self, value: Any, dialect: Dialect) -> Any:  # noqa: ANN401 - SQLAlchemy typing
        """Ensure JSON payloads contain only JSON-serializable primitives.

        Production incidents have been triggered by uuid.UUID values leaking into JSONB columns,
        which psycopg cannot serialize by default. We enforce a strict boundary here so callers
        can pass in Pydantic models, UUIDs, datetimes, Decimals, etc., without crashing at commit time.
        """

        if value is None:
            return None

        encoded = _JSON_ADAPTER.dump_python(value, mode="json")
        _assert_no_uuid(encoded)
        return encoded


def coerce_json_payload(value: Any) -> Any:
    if value is None:
        return None
    encoded = _JSON_ADAPTER.dump_python(value, mode="json")
    _assert_no_uuid(encoded)
    return encoded


def _assert_no_uuid(value: Any, path: str = "$") -> None:
    if isinstance(value, uuid.UUID):
        raise ValueError(f"uuid.UUID leaked into JSON payload at {path}")
    if isinstance(value, dict):
        for key, child in cast(dict[object, Any], value).items():
            _assert_no_uuid(child, f"{path}.{key!s}")
        return
    if isinstance(value, (list, tuple)):
        for index, child in enumerate(cast(list[Any] | tuple[Any, ...], value)):
            _assert_no_uuid(child, f"{path}[{index}]")



__all__ = ["Base", "GUID", "JSONType", "coerce_json_payload", "metadata_obj"]
