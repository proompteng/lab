# torghut migrations

Alembic is scoped to this service.

## Setup

```bash
cd services/torghut
uv venv .venv
source .venv/bin/activate
uv pip install .[dev]
```

## Run migrations

```bash
cd services/torghut
# ensure DB_DSN / DB_URL / DATABASE_URL is set if not using the default
alembic upgrade head

# create a new revision (autogenerate)
alembic revision --autogenerate -m "short message"
```

Alembic reads the connection string from `DB_DSN` via `app.config.settings` and targets the ORM models under `app.models`.
