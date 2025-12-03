# torghut

FastAPI service scaffold for an autonomous Alpaca paper trading bot powered by Codex.

## Local dev (uv-native)
```bash
cd services/torghut
uv venv .venv
source .venv/bin/activate
uv pip install .

# configure env (DB_DSN defaults to local compose: postgresql+psycopg://torghut:torghut@localhost:15438/torghut)
export APP_ENV=dev
# optional:
# export DB_DSN=...               # override if not using local compose
# export APCA_API_KEY_ID=...
# export APCA_API_SECRET_KEY=...
# export APCA_API_BASE_URL=...

# shortcuts
# normal server
uv run uvicorn app.main:app --host 0.0.0.0 --port 8181

# hot reload
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8181

# type checking
uv run pyright
```

Health checks:
- `GET /healthz` – liveness (default port 8181)
- `GET /db-check` – requires reachable Postgres at `DB_DSN` (default port 8181)
