# Torghut Main And Simple Pipeline Production Refactor Plan

## Summary

- Split the refactor into two production PRs to keep review and rollback sane:
  - PR 1: `simple_pipeline.py` extraction.
  - PR 2: `app/main.py` API extraction.
- Each PR must pass local Torghut validation, GitHub checks, image promotion, Argo rollout, and live smoke before the next PR starts.
- Preserve trading behavior, proof authority, route contracts, JSON fields, scheduler decision metadata, and fail-closed promotion gates.

## Key Changes

- `services/torghut/app/trading/scheduler/simple_pipeline.py`
  - Extract target-plan, probe, source-collection, and submission helpers into focused scheduler modules.
  - Keep `SimpleTradingPipeline` as the scheduler orchestration surface.
  - Keep temporary compatibility wrappers until tests and `rg` prove old private imports are gone.

- `services/torghut/app/main.py`
  - Extract route groups into `services/torghut/app/api/`: readiness, trading health, trading status, paper-route, runtime profitability, whitepaper, and maintenance.
  - Keep `main.py` focused on FastAPI composition: app creation, lifespan, exception handler, router registration, and `/healthz`.
  - Preserve all route paths, status codes, auth behavior, response keys, and fail-closed promotion semantics.

- Cleanup
  - Remove compatibility wrappers only after import scans are clean.
  - Do not touch untracked artifacts such as `.coverage`.
  - This file is the canonical plan for this refactor.

## PR And Rollout Plan

1. Start PR 1 from fresh `origin/main` on `codex/torghut-simple-pipeline-refactor`.
2. Implement and validate the scheduler extraction.
3. Open PR 1 as `refactor(torghut): split simple pipeline helpers` using `.github/PULL_REQUEST_TEMPLATE.md`.
4. Wait for green GitHub checks, squash merge, wait for Torghut image build and GitOps release PR, merge the release PR after checks pass, then smoke the rollout.
5. Start PR 2 from fresh `origin/main` on `codex/torghut-main-api-refactor`.
6. Implement and validate the API extraction.
7. Open PR 2 as `refactor(torghut): split main api routes`, wait for green checks, squash merge, release, and smoke.

## Validation

### PR 1 local validation

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pytest tests/test_simple_pipeline.py tests/test_trading_scheduler_safety.py -q
uv run --frozen pytest tests/test_trading_pipeline.py -k 'paper_route or probe or target_plan or buying_power or submission' -q
uv run --frozen ruff check app/trading/scheduler tests/test_simple_pipeline.py tests/test_trading_pipeline.py tests/test_trading_scheduler_safety.py
uv run --frozen ruff format --check app/trading/scheduler tests/test_simple_pipeline.py tests/test_trading_pipeline.py tests/test_trading_scheduler_safety.py
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

### PR 2 local validation

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pytest tests/test_trading_api.py tests/test_whitepaper_api.py tests/test_trading_proofs_api.py -q
uv run --frozen ruff check app/main.py app/api tests/test_trading_api.py tests/test_whitepaper_api.py tests/test_trading_proofs_api.py
uv run --frozen ruff format --check app/main.py app/api tests/test_trading_api.py tests/test_whitepaper_api.py tests/test_trading_proofs_api.py
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

### Size gate

```bash
cd services/torghut
wc -l app/main.py app/trading/scheduler/simple_pipeline.py app/api/*.py app/trading/scheduler/*.py
```

- `app/main.py` target: under 1,500 lines.
- `simple_pipeline.py` target: under 3,500 lines.
- No new module above 3,000 lines.

## Smoke Test

After each rollout:

```bash
kubectl -n torghut get ksvc torghut torghut-sim -o json \
  | jq '.items[] | {name:.metadata.name, ready:(.status.conditions[]? | select(.type=="Ready") | .status), latestReady:.status.latestReadyRevisionName, url:.status.url}'
```

From a running `torghut` pod, hit:

- `/healthz`
- `/readyz`
- `/trading/status`
- `/trading/health`
- `/trading/proofs?kind=runtime_window&window=latest_closed&full_audit=true&limit=5`

Required smoke result:

- Endpoints return the same success or fail-closed status shape as before refactor.
- Live and sim report the promoted commit and digest.
- `promotion_allowed` remains false unless independent runtime-ledger authority clears.
- Close any auto rollback PR only after the smoke evidence is clean.

## Assumptions

- This is refactor-only production hardening.
- Two PRs are the default blast-radius boundary.
- CI/CD and GitOps remain the deployment path; do not deploy directly from a local worktree.
- If a refactor changes runtime behavior unexpectedly, stop and fix the behavior before continuing extraction.
