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

## Torghut v3 Autonomous Lane (phase-1/phase-2 foundation)

Run a deterministic local lane from research candidate input to gate report and paper patch artifacts:

```bash
cd services/torghut
uv run scripts/run_autonomous_lane.py \
  --candidate-spec tests/fixtures/autonomy_candidate.json \
  --signals tests/fixtures/walkforward_signals.json \
  --strategy-config ../../argocd/applications/torghut/strategy-configmap.yaml \
  --gate-policy config/autonomy-gates-v3.json \
  --artifact-dir /tmp/torghut-autonomy \
  --start 2026-01-01T00:00:00Z \
  --end 2026-01-01T00:30:00Z
```

Outputs include:
- `research-artifact.json`
- `walkforward-results.json`
- `evaluation-report.json`
- `metrics-bundle.json`
- `gate-report.json`
- `paper-candidate-patch.yaml`
