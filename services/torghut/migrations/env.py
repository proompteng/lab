"""Alembic environment for torghut."""

from __future__ import annotations

import logging
from logging.config import fileConfig

from alembic import context
from sqlalchemy import engine_from_config, pool

from app.config import settings
from app.models import Base

config = context.config

if config.config_file_name is not None:  # pragma: no cover - Alembic bootstrap
    fileConfig(config.config_file_name)

logger = logging.getLogger(__name__)

target_metadata = Base.metadata


def get_url() -> str:
    return settings.sqlalchemy_dsn


def run_migrations_offline() -> None:
    url = get_url()
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = get_url()

    connectable = engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        future=True,
    )

    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():  # pragma: no cover - Alembic runtime
    run_migrations_offline()
else:  # pragma: no cover - Alembic runtime
    run_migrations_online()
