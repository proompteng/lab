# Torghut Pylint File Length Debt Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Pylint as a blocking Torghut quality gate, eliminate every Python module over the configured file-length limit, and modularize the largest Torghut app, script, and test files without weakening trading, proof, or promotion authority behavior.

**Architecture:** Treat file length as an enforceable symptom of unclear boundaries, not as the only debt measure. First lock in Pylint and public behavior tests, then split oversized files by runtime responsibility while preserving import compatibility through thin wrappers until direct imports and tests are migrated. Finish by making Pylint blocking in CI with no file-length suppressions.

**Tech Stack:** Python 3.11, uv, Pylint `too-many-lines / C0302`, Pyright, Ruff, pytest, coverage, GitHub Actions.

---

## Current Context

- Branch: `codex/torghut-pylint-file-length-gate-20260612`.
- Base: `origin/main` at `e2170165c`.
- Pylint is not currently in `services/torghut/pyproject.toml`.
- Current blocking Torghut CI includes Ruff, compileall, migration graph, pytest shards, coverage, changed-file coverage, and three Pyright profiles.
- Pylint docs define `too-many-lines / C0302` and `max-module-lines`; `max-module-lines` belongs under `[tool.pylint.format]`, defaulting to `1000`.
- Current Python files over 1000 lines across `app`, `scripts`, `tests`, and `migrations`: `141`.
- Current largest files:
  - `services/torghut/tests/test_trading_pipeline.py`: `25175`.
  - `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`: `13613`.
  - `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py`: `13153`.
  - `services/torghut/tests/test_import_hypothesis_runtime_windows.py`: `11503`.
  - `services/torghut/tests/test_trading_api.py`: `10695`.
  - `services/torghut/tests/test_start_historical_simulation.py`: `9942`.
  - `services/torghut/scripts/start_historical_simulation.py`: `8303`.
  - `services/torghut/scripts/import_hypothesis_runtime_windows.py`: `7851`.
  - `services/torghut/scripts/search_consistent_profitability_frontier.py`: `7621`.
  - `services/torghut/tests/test_search_consistent_profitability_frontier.py`: `7424`.
  - `services/torghut/app/trading/autonomy/lane.py`: `7415`.
  - `services/torghut/app/trading/discovery/candidate_specs.py`: `7271`.
  - `services/torghut/tests/test_submission_council.py`: `7242`.
  - `services/torghut/tests/test_strategy_runtime.py`: `6657`.
  - `services/torghut/app/trading/autonomy/policy_checks.py`: `6425`.
  - `services/torghut/tests/test_policy_checks.py`: `6070`.
  - `services/torghut/tests/test_decisions.py`: `5595`.
  - `services/torghut/tests/test_run_empirical_promotion_jobs.py`: `5528`.
  - `services/torghut/app/trading/research_sleeves.py`: `5254`.
  - `services/torghut/tests/test_order_feed.py`: `5223`.
  - `services/torghut/app/trading/submission_council.py`: `5160`.
  - `services/torghut/app/trading/scheduler/pipeline.py`: `5116`.
  - `services/torghut/app/whitepapers/workflow.py`: `5003`.

## Non-Negotiable Guardrails

- Do not relax proof, runtime-ledger, paper-route, TigerBeetle, or promotion authority gates.
- Do not use `# pylint: disable=too-many-lines` to pass the final gate.
- Do not delete compatibility exports from `app.main` until every direct test/import dependency has been migrated or protected by compatibility tests.
- Do not hand-edit `uv.lock`; regenerate it with `uv lock` after adding Pylint.
- Do not fold behavior changes into extraction PRs. Each extraction PR should be behavior-preserving unless the task explicitly calls out a bug fix with a failing regression test.
- Do not deploy from the local worktree. Push commits and let CI/CD handle builds and rollouts.

## Target File Structure

- Modify: `services/torghut/pyproject.toml`
  - Add Pylint to `dev`.
  - Configure `max-module-lines = 1000` under `[tool.pylint.format]`.
  - Configure design thresholds under `[tool.pylint.design]` for the later strict-design gate.
- Modify: `.github/workflows/torghut-ci.yml`
  - Add blocking Pylint checks after Ruff in `static-guards`.
  - Keep the design gate non-blocking until the relevant app/script modules pass, then flip to blocking.
- Modify: `services/torghut/README.md`
  - Document the Pylint commands and the no-suppression policy.
- Create: `docs/torghut/tech-debt/file-length-inventory-2026-06-12.md`
  - Record the starting inventory and tranche order.
- Refactor: `services/torghut/app/main.py`
  - Keep it as a thin application assembly and compatibility surface.
- Create: `services/torghut/app/api/app_factory.py`
  - Own FastAPI construction, route registration, exception handler registration, and app state.
- Create: `services/torghut/app/api/auth.py`
  - Own bearer-token extraction and whitepaper control-token validation.
- Create: `services/torghut/app/api/env.py`
  - Own API-local env parsing helpers.
- Create: `services/torghut/app/api/lifecycle.py`
  - Own lifespan startup and shutdown.
- Create: `services/torghut/app/api/errors.py`
  - Own SQLAlchemy exception handling.
- Create: `services/torghut/scripts/whitepaper_autoresearch/`
  - Split `run_whitepaper_autoresearch_profit_target.py` into CLI, config, epoch orchestration, result persistence, candidate evidence, and notebook/report output modules.
- Create: `services/torghut/scripts/runtime_window_import/`
  - Split `import_hypothesis_runtime_windows.py` into CLI, parsing, source-row normalization, lineage, fee/cost authority, query builders, runtime-ledger materialization, and audit payload modules.
- Create: `services/torghut/scripts/historical_simulation/`
  - Split `start_historical_simulation.py` into CLI, job request payloads, polling, persistence, and verification helpers.
- Create: `services/torghut/scripts/profitability_frontier/`
  - Split `search_consistent_profitability_frontier.py` into policy, budget, worklist, replay-window, and output modules.
- Convert: `services/torghut/app/trading/submission_council.py` into `services/torghut/app/trading/submission_council/__init__.py`
  - Preserve `app.trading.submission_council` import compatibility while moving internals into focused modules.
- Convert: `services/torghut/app/trading/discovery/candidate_specs.py` into `services/torghut/app/trading/discovery/candidate_specs/__init__.py`
  - Preserve public exports while moving models, profile selection, mechanism overlays, compiler, and serialization.
- Convert: `services/torghut/app/trading/research_sleeves.py` into `services/torghut/app/trading/research_sleeves/__init__.py`
  - Preserve evaluator names while moving each strategy family into its own module.
- Convert: `services/torghut/app/trading/autonomy/policy_checks.py` into `services/torghut/app/trading/autonomy/policy_checks/__init__.py`
  - Preserve public policy-check APIs while moving evidence-family validators into dedicated modules.
- Split tests into subdirectories:
  - `services/torghut/tests/api/`
  - `services/torghut/tests/scheduler/`
  - `services/torghut/tests/scripts/whitepaper_autoresearch/`
  - `services/torghut/tests/scripts/runtime_window_import/`
  - `services/torghut/tests/discovery/`
  - `services/torghut/tests/autonomy/`

## Success Criteria

- `uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n` passes.
- No Python file in `services/torghut/app`, `services/torghut/scripts`, `services/torghut/tests`, or `services/torghut/migrations` is over `1000` lines.
- App and scripts still pass Ruff and all three Pyright profiles.
- Touched test files pass, then full Torghut pytest shards pass in CI.
- Changed-file coverage remains at or above `90`.
- `app.main` remains import-compatible until tests are migrated away from patching internals.
- Each refactor PR has bounded scope, exact validation, and no unrelated behavior change.

## Task 1: Install Pylint and Record the Starting Debt Inventory

**Files:**
- Modify: `services/torghut/pyproject.toml`
- Modify: `services/torghut/uv.lock`
- Create: `docs/torghut/tech-debt/file-length-inventory-2026-06-12.md`
- Modify: `services/torghut/README.md`

- [ ] **Step 1: Add Pylint to Torghut dev dependencies**

Patch `services/torghut/pyproject.toml`:

```toml
dev = [
  "coverage[toml]>=7.10.0,<8.0",
  "crosshair-tool>=0.0.95,<1.0",
  "hypothesis>=6.151.0,<7.0",
  "mutmut>=3.3.1,<4.0",
  "pylint>=4.0.0,<5.0",
  "pyright>=1.1.389,<2.0",
  "pytest>=8.4.0,<9.0",
  "pytest-cov>=7.0.0,<8.0",
  "pytest-xdist>=3.8.0,<4.0",
  "ruff>=0.9.0,<1.0",
]
```

- [ ] **Step 2: Add Pylint file-length and design configuration**

Append to `services/torghut/pyproject.toml`:

```toml
[tool.pylint.format]
max-module-lines = 1000

[tool.pylint.design]
max-args = 5
max-branches = 12
max-locals = 15
max-returns = 6
max-statements = 50
```

- [ ] **Step 3: Regenerate the lockfile**

Run:

```bash
cd services/torghut
uv lock
```

Expected: `services/torghut/uv.lock` includes Pylint and its transitive dependencies.

- [ ] **Step 4: Capture the starting inventory**

Run:

```bash
cd /Users/gregkonush/.codex/worktrees/ccea/lab
rg --files services/torghut/app services/torghut/scripts services/torghut/tests services/torghut/migrations \
  | rg '\.py$' \
  | xargs wc -l \
  | sort -nr \
  > /tmp/torghut-file-lengths-2026-06-12.txt
```

Create `docs/torghut/tech-debt/file-length-inventory-2026-06-12.md` with this content:

```markdown
# Torghut File Length Inventory - 2026-06-12

Scope: `services/torghut/app`, `services/torghut/scripts`, `services/torghut/tests`, and `services/torghut/migrations`.

Rule target: Pylint `too-many-lines / C0302` with `max-module-lines = 1000`.

Starting count above target: 141 Python files.

Top priority files:

| Lines | File | Tranche |
| ---: | --- | --- |
| 25175 | `services/torghut/tests/test_trading_pipeline.py` | Scheduler tests |
| 13613 | `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py` | Whitepaper autoresearch tests |
| 13153 | `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py` | Whitepaper autoresearch script |
| 11503 | `services/torghut/tests/test_import_hypothesis_runtime_windows.py` | Runtime-window import tests |
| 10695 | `services/torghut/tests/test_trading_api.py` | API tests |
| 9942 | `services/torghut/tests/test_start_historical_simulation.py` | Historical simulation tests |
| 8303 | `services/torghut/scripts/start_historical_simulation.py` | Historical simulation script |
| 7851 | `services/torghut/scripts/import_hypothesis_runtime_windows.py` | Runtime-window import script |
| 7621 | `services/torghut/scripts/search_consistent_profitability_frontier.py` | Profitability frontier script |
| 7424 | `services/torghut/tests/test_search_consistent_profitability_frontier.py` | Profitability frontier tests |
| 7415 | `services/torghut/app/trading/autonomy/lane.py` | Autonomy runtime |
| 7271 | `services/torghut/app/trading/discovery/candidate_specs.py` | Candidate spec compiler |
| 7242 | `services/torghut/tests/test_submission_council.py` | Submission council tests |
| 6657 | `services/torghut/tests/test_strategy_runtime.py` | Strategy runtime tests |
| 6425 | `services/torghut/app/trading/autonomy/policy_checks.py` | Policy checks |
| 6070 | `services/torghut/tests/test_policy_checks.py` | Policy checks tests |
| 5595 | `services/torghut/tests/test_decisions.py` | Decision tests |
| 5528 | `services/torghut/tests/test_run_empirical_promotion_jobs.py` | Empirical jobs tests |
| 5254 | `services/torghut/app/trading/research_sleeves.py` | Research sleeves |
| 5223 | `services/torghut/tests/test_order_feed.py` | Order-feed tests |
| 5160 | `services/torghut/app/trading/submission_council.py` | Submission council |
| 5116 | `services/torghut/app/trading/scheduler/pipeline.py` | Scheduler pipeline |
| 5003 | `services/torghut/app/whitepapers/workflow.py` | Whitepaper workflow |

Final acceptance: zero scoped Python files over 1000 lines and no inline `too-many-lines` suppressions.
```

- [ ] **Step 5: Add README commands**

Add this section to `services/torghut/README.md` after the type-checking section:

```markdown
## Pylint file-length guard

Torghut enforces Pylint `too-many-lines / C0302` as the hard module-size gate.

```bash
cd services/torghut
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
```

The limit is configured in `[tool.pylint.format]` as `max-module-lines = 1000`.
Do not suppress `too-many-lines`; split the module by responsibility instead.
```

- [ ] **Step 6: Verify dependency installation**

Run:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pylint --version
```

Expected: Pylint prints a `4.x` version.

- [ ] **Step 7: Commit the tooling setup**

Run:

```bash
git add services/torghut/pyproject.toml services/torghut/uv.lock services/torghut/README.md docs/torghut/tech-debt/file-length-inventory-2026-06-12.md
git commit -m "chore(torghut): add pylint file length guard"
```

## Task 2: Add CI Gates Without Hiding the Existing Debt

**Files:**
- Modify: `.github/workflows/torghut-ci.yml`
- Modify: `services/torghut/README.md`

- [ ] **Step 1: Add an informational inventory command to CI first**

Add this after the Ruff step in `static-guards`:

```yaml
      - name: File length inventory
        working-directory: services/torghut
        run: |
          set -euo pipefail
          uv run --frozen python - <<'PY'
          from pathlib import Path

          roots = [Path("app"), Path("scripts"), Path("tests"), Path("migrations")]
          oversized = []
          for root in roots:
              for path in root.rglob("*.py"):
                  lines = path.read_text(encoding="utf-8").count("\n") + 1
                  if lines > 1000:
                      oversized.append((lines, path.as_posix()))
          for lines, path in sorted(oversized, reverse=True)[:40]:
              print(f"{lines:6d} {path}")
          print(f"oversized_python_files={len(oversized)}")
          PY
```

Expected: CI logs the top oversized files but does not pass off the debt as fixed.

- [ ] **Step 2: Add the final blocking Pylint step behind a temporary branch-local marker**

Add this step immediately after the inventory step, but do not push it as required on `main` until Task 9 is complete:

```yaml
      - name: Pylint file length
        working-directory: services/torghut
        run: uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
```

Expected before refactors: fails with `C0302` messages.

- [ ] **Step 3: Keep design complexity separate from file length**

Add this non-blocking step to `quality-signals`:

```yaml
      - name: Pylint design scan (non-blocking)
        working-directory: services/torghut
        run: uv run --frozen pylint app scripts --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n --exit-zero
```

Expected: CI exposes function-level complexity hotspots while the file-length cleanup proceeds.

- [ ] **Step 4: Verify CI YAML syntax and local commands**

Run:

```bash
cd /Users/gregkonush/.codex/worktrees/ccea/lab
bun run lint:argocd
cd services/torghut
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
```

Expected now: `lint:argocd` passes; Pylint fails until oversized files are split.

- [ ] **Step 5: Commit the CI visibility step**

Run:

```bash
git add .github/workflows/torghut-ci.yml services/torghut/README.md
git commit -m "ci(torghut): surface pylint file length debt"
```

## Task 3: Protect Public API and Compatibility Before Moving Code

**Files:**
- Modify: `services/torghut/tests/test_main_api_refactor.py`
- Modify: `services/torghut/tests/test_trading_api.py`
- Modify: `services/torghut/tests/test_whitepaper_api.py`

- [ ] **Step 1: Add an app factory compatibility test**

Add this test to `services/torghut/tests/test_main_api_refactor.py`:

```python
def test_app_main_keeps_fastapi_app_and_route_compatibility() -> None:
    import app.main as main_module

    assert main_module.app.title == "torghut"
    route_paths = {route.path for route in main_module.app.routes}
    assert "/healthz" in route_paths
    assert "/trading/status" in route_paths
    assert "/trading/health" in route_paths
```

- [ ] **Step 2: Add a proxy export compatibility test for patched names**

Add this test to `services/torghut/tests/test_main_api_refactor.py`:

```python
def test_app_main_keeps_legacy_patch_targets_available() -> None:
    import app.main as main_module

    required_names = [
        "_build_live_submission_gate_payload",
        "_check_account_scope_invariants_bounded",
        "_check_alpaca",
        "_check_clickhouse",
        "_check_postgres",
        "_evaluate_database_contract",
        "_evaluate_trading_health_payload",
        "_load_tca_summary",
        "_load_external_paper_route_target_plan",
        "trading_status",
        "trading_health",
        "readyz",
    ]
    missing = [name for name in required_names if not hasattr(main_module, name)]
    assert missing == []
```

- [ ] **Step 3: Run the compatibility tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_main_api_refactor.py tests/test_whitepaper_api.py tests/test_trading_proofs_api.py -q
```

Expected: tests pass before any extraction.

- [ ] **Step 4: Commit compatibility coverage**

Run:

```bash
git add services/torghut/tests/test_main_api_refactor.py services/torghut/tests/test_whitepaper_api.py services/torghut/tests/test_trading_api.py
git commit -m "test(torghut): lock main api compatibility"
```

## Task 4: Shrink `app/main.py` Into App Assembly Only

**Files:**
- Create: `services/torghut/app/api/app_factory.py`
- Create: `services/torghut/app/api/auth.py`
- Create: `services/torghut/app/api/env.py`
- Create: `services/torghut/app/api/lifecycle.py`
- Create: `services/torghut/app/api/errors.py`
- Create: `services/torghut/app/api/whitepaper_inngest.py`
- Modify: `services/torghut/app/main.py`
- Test: `services/torghut/tests/test_main_api_refactor.py`
- Test: `services/torghut/tests/test_trading_api.py`
- Test: `services/torghut/tests/test_whitepaper_api.py`

- [ ] **Step 1: Extract auth helpers**

Create `services/torghut/app/api/auth.py`:

```python
"""Authentication helpers for Torghut API routes and callbacks."""

from __future__ import annotations

import os

from fastapi import HTTPException, Request


def extract_bearer_token(authorization_header: str | None) -> str | None:
    if authorization_header is None:
        return None
    scheme, _, token = authorization_header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()


def require_whitepaper_control_token(request: Request) -> None:
    expected_token = os.environ.get("WHITEPAPER_CONTROL_TOKEN", "").strip()
    if not expected_token:
        return
    actual_token = extract_bearer_token(request.headers.get("authorization"))
    if actual_token != expected_token:
        raise HTTPException(status_code=401, detail="invalid whitepaper control token")
```

In `app/main.py`, replace existing private implementations with imports and aliases:

```python
from .api.auth import extract_bearer_token as _extract_bearer_token
from .api.auth import require_whitepaper_control_token as _require_whitepaper_control_token
```

- [ ] **Step 2: Extract env helpers**

Create `services/torghut/app/api/env.py`:

```python
"""Environment parsing helpers for API assembly."""

from __future__ import annotations

import json
import os


def env_or_none(name: str) -> str | None:
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def env_csv(name: str) -> tuple[str, ...]:
    value = env_or_none(name)
    if value is None:
        return ()
    return tuple(item.strip() for item in value.split(",") if item.strip())


def env_json_string_list(name: str) -> tuple[str, ...]:
    value = env_or_none(name)
    if value is None:
        return ()
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        return ()
    if not isinstance(payload, list):
        return ()
    return tuple(item for item in payload if isinstance(item, str) and item.strip())
```

In `app/main.py`, replace private implementations with imports and aliases:

```python
from .api.env import env_csv as _env_csv
from .api.env import env_json_string_list as _env_json_string_list
from .api.env import env_or_none as _env_or_none
```

- [ ] **Step 3: Extract exception handler**

Create `services/torghut/app/api/errors.py`:

```python
"""API exception handlers."""

from __future__ import annotations

import logging

from fastapi import Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import SQLAlchemyError

from app.observability.posthog import capture_posthog_event

logger = logging.getLogger(__name__)


def sqlalchemy_exception_handler(
    _request: Request,
    exc: SQLAlchemyError,
) -> JSONResponse:
    message = str(getattr(exc, "orig", exc)).lower()
    if "undefinedcolumn" in message or ("column" in message and "does not exist" in message):
        detail = "database schema mismatch; migrations pending"
    else:
        detail = "database unavailable"
    capture_posthog_event(
        "torghut.runtime.db_exception",
        severity="error",
        properties={
            "loop": "http",
            "error_class": type(exc).__name__,
            "detail": detail,
        },
    )
    logger.error("Unhandled database exception: %s", exc)
    return JSONResponse(status_code=503, content={"detail": detail})
```

In `app/main.py`, import it:

```python
from .api.errors import sqlalchemy_exception_handler
```

- [ ] **Step 4: Extract app factory and route registration**

Create `services/torghut/app/api/whitepaper_inngest.py` by moving `_register_whitepaper_inngest_routes()` out of `app/main.py`. Preserve the existing function body and imports, then export it as:

```python
def register_whitepaper_inngest_routes(app: FastAPI) -> inngest.Inngest | None:
    ...
```

Create `services/torghut/app/api/app_factory.py`:

```python
"""FastAPI application assembly for Torghut."""

from __future__ import annotations

from collections.abc import Sequence
from types import ModuleType

from fastapi import FastAPI
from sqlalchemy.exc import SQLAlchemyError

from app.api import (
    health_checks as health_checks_api,
    maintenance as maintenance_api,
    proof_floor_payloads as proof_floor_payloads_api,
    proofs as proofs_api,
    readiness as readiness_api,
    readiness_helpers as readiness_helpers_api,
    runtime_profitability as runtime_profitability_api,
    runtime_profitability_helpers as runtime_profitability_helpers_api,
    status_helpers as status_helpers_api,
    trading_health as trading_health_api,
    trading_misc as trading_misc_api,
    trading_status as trading_status_api,
    vnext_helpers as vnext_helpers_api,
    whitepaper as whitepaper_api,
)
from app.api.errors import sqlalchemy_exception_handler
from app.api.whitepaper_inngest import register_whitepaper_inngest_routes
from app.config import settings
from app.trading.autoresearch_routes import router as autoresearch_router

API_MODULES: tuple[ModuleType, ...] = (
    status_helpers_api,
    readiness_helpers_api,
    readiness_api,
    maintenance_api,
    whitepaper_api,
    trading_status_api,
    trading_misc_api,
    runtime_profitability_api,
    proofs_api,
    trading_health_api,
    health_checks_api,
    proof_floor_payloads_api,
    runtime_profitability_helpers_api,
    vnext_helpers_api,
)


def register_api_routers(app: FastAPI, api_modules: Sequence[ModuleType] = API_MODULES) -> None:
    app.include_router(autoresearch_router)
    for api_module in api_modules:
        router = getattr(api_module, "router", None)
        if router is not None:
            app.include_router(router)


def create_app() -> FastAPI:
    from app.api.lifecycle import lifespan

    app = FastAPI(title="torghut", lifespan=lifespan)
    app.state.settings = settings
    app.state.whitepaper_inngest_registered = False
    register_api_routers(app)
    app.add_exception_handler(SQLAlchemyError, sqlalchemy_exception_handler)
    register_whitepaper_inngest_routes(app)
    return app
```

In `app/main.py`, keep a compatibility alias:

```python
from .api.whitepaper_inngest import register_whitepaper_inngest_routes as _register_whitepaper_inngest_routes
```

- [ ] **Step 5: Run API compatibility tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_main_api_refactor.py tests/test_trading_api.py tests/test_whitepaper_api.py tests/test_trading_proofs_api.py -q
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen ruff check app/main.py app/api tests/test_main_api_refactor.py
```

Expected: tests pass, Pyright has `0 errors`, Ruff passes.

- [ ] **Step 6: Commit the app assembly split**

Run:

```bash
git add services/torghut/app/main.py services/torghut/app/api services/torghut/tests/test_main_api_refactor.py
git commit -m "refactor(torghut): split app assembly from main"
```

## Task 5: Split Giant API Tests by Endpoint Family

**Files:**
- Modify: `services/torghut/tests/test_trading_api.py`
- Create: `services/torghut/tests/api/test_trading_status_api.py`
- Create: `services/torghut/tests/api/test_trading_health_api.py`
- Create: `services/torghut/tests/api/test_readiness_api.py`
- Create: `services/torghut/tests/api/test_paper_route_api.py`
- Create: `services/torghut/tests/api/test_runtime_profitability_api.py`
- Create: `services/torghut/tests/api/conftest.py`

- [ ] **Step 1: Add shared API test helpers**

Create `services/torghut/tests/api/conftest.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)
```

- [ ] **Step 2: Move `/trading/status` tests**

Move status tests and helpers from `test_trading_api.py` into `tests/api/test_trading_status_api.py`. Keep patch paths working through `app.main` during this step.

Header for the new file:

```python
from __future__ import annotations

from decimal import Decimal
from unittest.mock import patch

from fastapi.testclient import TestClient
```

- [ ] **Step 3: Move `/trading/health` and `/readyz` tests**

Move health/readiness tests into:

```text
services/torghut/tests/api/test_trading_health_api.py
services/torghut/tests/api/test_readiness_api.py
```

Keep names descriptive, such as:

```python
def test_trading_health_degrades_when_clickhouse_is_down(client: TestClient) -> None:
    ...
```

- [ ] **Step 4: Move paper-route and profitability API tests**

Move paper-route target/evidence and runtime profitability tests into:

```text
services/torghut/tests/api/test_paper_route_api.py
services/torghut/tests/api/test_runtime_profitability_api.py
```

- [ ] **Step 5: Run split API tests**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/api tests/test_main_api_refactor.py -q
uv run --frozen pylint tests/api tests/test_trading_api.py --disable=all --enable=too-many-lines --score=n
```

Expected: split tests pass, and no new API test file exceeds `1000` lines. `test_trading_api.py` keeps shrinking until it is empty or below the limit.

- [ ] **Step 6: Remove empty original test file or leave a compatibility comment**

If `services/torghut/tests/test_trading_api.py` has no tests left, delete it. If it still has shared tests, keep it under `1000` lines.

- [ ] **Step 7: Commit API test split**

Run:

```bash
git add services/torghut/tests/test_trading_api.py services/torghut/tests/api
git commit -m "test(torghut): split trading api tests by endpoint"
```

## Task 6: Split Whitepaper Autoresearch Script and Tests

**Files:**
- Modify: `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py`
- Create: `services/torghut/scripts/whitepaper_autoresearch/__init__.py`
- Create: `services/torghut/scripts/whitepaper_autoresearch/cli.py`
- Create: `services/torghut/scripts/whitepaper_autoresearch/config.py`
- Create: `services/torghut/scripts/whitepaper_autoresearch/epoch_runner.py`
- Create: `services/torghut/scripts/whitepaper_autoresearch/evidence.py`
- Create: `services/torghut/scripts/whitepaper_autoresearch/persistence.py`
- Create: `services/torghut/scripts/whitepaper_autoresearch/reports.py`
- Modify: `services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py`
- Create: `services/torghut/tests/scripts/whitepaper_autoresearch/`

- [ ] **Step 1: Make the existing script a wrapper**

Replace `services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py` with:

```python
"""CLI wrapper for whitepaper autoresearch profit-target runs."""

from __future__ import annotations

from scripts.whitepaper_autoresearch.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Create the package initializer**

Create `services/torghut/scripts/whitepaper_autoresearch/__init__.py`:

```python
"""Whitepaper autoresearch profit-target orchestration package."""
```

- [ ] **Step 3: Extract CLI parsing**

Create `services/torghut/scripts/whitepaper_autoresearch/cli.py`:

```python
from __future__ import annotations

import argparse
from collections.abc import Sequence

from scripts.whitepaper_autoresearch.config import WhitepaperAutoresearchConfig, parse_config
from scripts.whitepaper_autoresearch.epoch_runner import run_whitepaper_autoresearch


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run whitepaper autoresearch profit-target evaluation.")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--target-daily-net", type=float, required=True)
    parser.add_argument("--max-candidates", type=int, default=128)
    parser.add_argument("--persist-results", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    config: WhitepaperAutoresearchConfig = parse_config(build_parser().parse_args(argv))
    result = run_whitepaper_autoresearch(config)
    return 0 if result.ok else 1
```

During extraction, copy the real existing parser options into `build_parser()` instead of dropping options. The wrapper must remain CLI-compatible with current CronJob and AgentRun invocations.

- [ ] **Step 4: Extract config objects**

Create `services/torghut/scripts/whitepaper_autoresearch/config.py` with typed dataclasses matching existing args:

```python
from __future__ import annotations

import argparse
from dataclasses import dataclass


@dataclass(frozen=True)
class WhitepaperAutoresearchConfig:
    run_id: str
    target_daily_net: float
    max_candidates: int
    persist_results: bool


def parse_config(args: argparse.Namespace) -> WhitepaperAutoresearchConfig:
    return WhitepaperAutoresearchConfig(
        run_id=str(args.run_id),
        target_daily_net=float(args.target_daily_net),
        max_candidates=int(args.max_candidates),
        persist_results=bool(args.persist_results),
    )
```

- [ ] **Step 5: Extract runner result type**

Create `services/torghut/scripts/whitepaper_autoresearch/epoch_runner.py`:

```python
from __future__ import annotations

from dataclasses import dataclass

from scripts.whitepaper_autoresearch.config import WhitepaperAutoresearchConfig


@dataclass(frozen=True)
class WhitepaperAutoresearchResult:
    ok: bool
    run_id: str


def run_whitepaper_autoresearch(config: WhitepaperAutoresearchConfig) -> WhitepaperAutoresearchResult:
    # Move the existing orchestration body here without changing persistence, replay, or proof semantics.
    return WhitepaperAutoresearchResult(ok=True, run_id=config.run_id)
```

Replace the stub body with the existing orchestration code from the current script in the same extraction step.

- [ ] **Step 6: Split tests by behavior**

Create these files and move tests by behavior:

```text
services/torghut/tests/scripts/whitepaper_autoresearch/test_cli.py
services/torghut/tests/scripts/whitepaper_autoresearch/test_config.py
services/torghut/tests/scripts/whitepaper_autoresearch/test_epoch_runner.py
services/torghut/tests/scripts/whitepaper_autoresearch/test_evidence.py
services/torghut/tests/scripts/whitepaper_autoresearch/test_persistence.py
services/torghut/tests/scripts/whitepaper_autoresearch/test_reports.py
```

Use this import pattern:

```python
from __future__ import annotations

from scripts.whitepaper_autoresearch.cli import build_parser
```

- [ ] **Step 7: Validate whitepaper autoresearch**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/scripts/whitepaper_autoresearch tests/test_run_whitepaper_autoresearch_profit_target.py -q
uv run --frozen pyright --project pyrightconfig.scripts.json
uv run --frozen ruff check scripts/run_whitepaper_autoresearch_profit_target.py scripts/whitepaper_autoresearch tests/scripts/whitepaper_autoresearch
uv run --frozen pylint scripts/run_whitepaper_autoresearch_profit_target.py scripts/whitepaper_autoresearch tests/scripts/whitepaper_autoresearch --disable=all --enable=too-many-lines --score=n
```

Expected: all commands pass, and every new file is under `1000` lines.

- [ ] **Step 8: Commit whitepaper split**

Run:

```bash
git add services/torghut/scripts/run_whitepaper_autoresearch_profit_target.py services/torghut/scripts/whitepaper_autoresearch services/torghut/tests/test_run_whitepaper_autoresearch_profit_target.py services/torghut/tests/scripts/whitepaper_autoresearch
git commit -m "refactor(torghut): modularize whitepaper autoresearch runner"
```

## Task 7: Split Runtime-Window Import Script and Tests

**Files:**
- Modify: `services/torghut/scripts/import_hypothesis_runtime_windows.py`
- Create: `services/torghut/scripts/runtime_window_import/__init__.py`
- Create: `services/torghut/scripts/runtime_window_import/cli.py`
- Create: `services/torghut/scripts/runtime_window_import/parsing.py`
- Create: `services/torghut/scripts/runtime_window_import/source_rows.py`
- Create: `services/torghut/scripts/runtime_window_import/lineage.py`
- Create: `services/torghut/scripts/runtime_window_import/costs.py`
- Create: `services/torghut/scripts/runtime_window_import/queries.py`
- Create: `services/torghut/scripts/runtime_window_import/ledger_materialization.py`
- Create: `services/torghut/scripts/runtime_window_import/audit.py`
- Modify: `services/torghut/tests/test_import_hypothesis_runtime_windows.py`
- Create: `services/torghut/tests/scripts/runtime_window_import/`

- [ ] **Step 1: Preserve script entrypoint**

Replace `services/torghut/scripts/import_hypothesis_runtime_windows.py` with:

```python
"""CLI wrapper for runtime-window import materialization."""

from __future__ import annotations

from scripts.runtime_window_import.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Create package initializer**

Create `services/torghut/scripts/runtime_window_import/__init__.py`:

```python
"""Runtime-window import helpers for source-backed proof materialization."""
```

- [ ] **Step 3: Move parsing and small coercion helpers**

Move these functions into `scripts/runtime_window_import/parsing.py`:

```text
_flag
_parse_dt
_parse_dt_or_none
_as_mapping
_as_sequence
_parse_target_metadata
_decimal_or_none
_text_or_none
_bool_value
```

Export them with the same names until tests are migrated.

- [ ] **Step 4: Move source-row authority helpers**

Move these families into `scripts/runtime_window_import/source_rows.py`:

```text
source decision mode helpers
source decision target-notional sizing helpers
source row lineage match helpers
source row filtering helpers
paper-route probe exit helpers
```

- [ ] **Step 5: Move lineage and digest helpers**

Move these families into `scripts/runtime_window_import/lineage.py`:

```text
stable payload digest helpers
runtime source lineage hash helpers
canonical runtime source ref helpers
runtime ledger artifact lineage helpers
```

- [ ] **Step 6: Move fee and cost authority helpers**

Move these families into `scripts/runtime_window_import/costs.py`:

```text
Alpaca 2026 equity fee schedule helpers
runtime execution cost amount helpers
runtime execution cost basis helpers
cost-basis authority checks
```

- [ ] **Step 7: Move SQL/query row builders**

Move these families into `scripts/runtime_window_import/queries.py`:

```text
decision lifecycle query row builders
execution query row builders
order lifecycle query row builders
timestamp query helpers
source-window query context helpers
```

- [ ] **Step 8: Move ledger materialization**

Move these families into `scripts/runtime_window_import/ledger_materialization.py`:

```text
runtime ledger bucket payload helpers
runtime ledger TCA row builders
runtime execution ledger fill builders
realized strategy PnL row builders
runtime ledger artifact row readers
source DSN materialization helpers
```

- [ ] **Step 9: Move audit payloads**

Move these families into `scripts/runtime_window_import/audit.py`:

```text
runtime-window import proof hygiene blockers
runtime observation authority payloads
runtime-window import audit summary
source activity diagnostics blockers
source activity missing summary
```

- [ ] **Step 10: Split tests by helper family**

Create:

```text
services/torghut/tests/scripts/runtime_window_import/test_parsing.py
services/torghut/tests/scripts/runtime_window_import/test_source_rows.py
services/torghut/tests/scripts/runtime_window_import/test_lineage.py
services/torghut/tests/scripts/runtime_window_import/test_costs.py
services/torghut/tests/scripts/runtime_window_import/test_queries.py
services/torghut/tests/scripts/runtime_window_import/test_ledger_materialization.py
services/torghut/tests/scripts/runtime_window_import/test_audit.py
services/torghut/tests/scripts/runtime_window_import/test_cli.py
```

- [ ] **Step 11: Validate runtime-window import**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/scripts/runtime_window_import tests/test_import_hypothesis_runtime_windows.py -q
uv run --frozen pyright --project pyrightconfig.scripts.json
uv run --frozen ruff check scripts/import_hypothesis_runtime_windows.py scripts/runtime_window_import tests/scripts/runtime_window_import
uv run --frozen pylint scripts/import_hypothesis_runtime_windows.py scripts/runtime_window_import tests/scripts/runtime_window_import --disable=all --enable=too-many-lines --score=n
```

Expected: behavior preserved and all files under `1000` lines.

- [ ] **Step 12: Commit runtime-window split**

Run:

```bash
git add services/torghut/scripts/import_hypothesis_runtime_windows.py services/torghut/scripts/runtime_window_import services/torghut/tests/test_import_hypothesis_runtime_windows.py services/torghut/tests/scripts/runtime_window_import
git commit -m "refactor(torghut): modularize runtime window import"
```

## Task 8: Split Historical Simulation and Profitability Frontier Scripts

**Files:**
- Modify: `services/torghut/scripts/start_historical_simulation.py`
- Modify: `services/torghut/scripts/search_consistent_profitability_frontier.py`
- Create: `services/torghut/scripts/historical_simulation/`
- Create: `services/torghut/scripts/profitability_frontier/`
- Modify: `services/torghut/tests/test_start_historical_simulation.py`
- Modify: `services/torghut/tests/test_search_consistent_profitability_frontier.py`
- Create: `services/torghut/tests/scripts/historical_simulation/`
- Create: `services/torghut/tests/scripts/profitability_frontier/`

- [ ] **Step 1: Convert historical simulation script into a wrapper**

Use this wrapper:

```python
"""CLI wrapper for historical simulation orchestration."""

from __future__ import annotations

from scripts.historical_simulation.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Split historical simulation modules**

Create:

```text
services/torghut/scripts/historical_simulation/__init__.py
services/torghut/scripts/historical_simulation/cli.py
services/torghut/scripts/historical_simulation/config.py
services/torghut/scripts/historical_simulation/job_payloads.py
services/torghut/scripts/historical_simulation/polling.py
services/torghut/scripts/historical_simulation/persistence.py
services/torghut/scripts/historical_simulation/verification.py
```

- [ ] **Step 3: Convert profitability frontier script into a wrapper**

Use this wrapper:

```python
"""CLI wrapper for consistent profitability frontier search."""

from __future__ import annotations

from scripts.profitability_frontier.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Split profitability frontier modules**

Create:

```text
services/torghut/scripts/profitability_frontier/__init__.py
services/torghut/scripts/profitability_frontier/cli.py
services/torghut/scripts/profitability_frontier/policies.py
services/torghut/scripts/profitability_frontier/budgets.py
services/torghut/scripts/profitability_frontier/replay_windows.py
services/torghut/scripts/profitability_frontier/worklist.py
services/torghut/scripts/profitability_frontier/output.py
```

- [ ] **Step 5: Split tests and validate**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/scripts/historical_simulation tests/scripts/profitability_frontier tests/test_start_historical_simulation.py tests/test_search_consistent_profitability_frontier.py -q
uv run --frozen pyright --project pyrightconfig.scripts.json
uv run --frozen ruff check scripts/start_historical_simulation.py scripts/search_consistent_profitability_frontier.py scripts/historical_simulation scripts/profitability_frontier tests/scripts/historical_simulation tests/scripts/profitability_frontier
uv run --frozen pylint scripts/start_historical_simulation.py scripts/search_consistent_profitability_frontier.py scripts/historical_simulation scripts/profitability_frontier tests/scripts/historical_simulation tests/scripts/profitability_frontier --disable=all --enable=too-many-lines --score=n
```

- [ ] **Step 6: Commit script splits**

Run:

```bash
git add services/torghut/scripts/start_historical_simulation.py services/torghut/scripts/search_consistent_profitability_frontier.py services/torghut/scripts/historical_simulation services/torghut/scripts/profitability_frontier services/torghut/tests
git commit -m "refactor(torghut): modularize simulation frontier scripts"
```

## Task 9: Modularize App Runtime Hotspots

**Files:**
- Convert: `services/torghut/app/trading/submission_council.py`
- Convert: `services/torghut/app/trading/discovery/candidate_specs.py`
- Convert: `services/torghut/app/trading/research_sleeves.py`
- Convert: `services/torghut/app/trading/autonomy/policy_checks.py`
- Modify corresponding tests.

- [ ] **Step 1: Convert `submission_council.py` to a package**

Move `services/torghut/app/trading/submission_council.py` to:

```text
services/torghut/app/trading/submission_council/__init__.py
```

Create these modules and move code by family:

```text
services/torghut/app/trading/submission_council/certificate_evidence.py
services/torghut/app/trading/submission_council/live_controls.py
services/torghut/app/trading/submission_council/market_context.py
services/torghut/app/trading/submission_council/paper_probation.py
services/torghut/app/trading/submission_council/profit_readiness.py
services/torghut/app/trading/submission_council/quant_evidence.py
services/torghut/app/trading/submission_council/runtime_ledger_candidates.py
services/torghut/app/trading/submission_council/source_collection.py
```

Keep public imports in `__init__.py`:

```python
from app.trading.submission_council.live_controls import build_live_submission_gate_payload
from app.trading.submission_council.market_context import build_submission_gate_market_context_status
```

Add every public function imported by tests or API modules.

- [ ] **Step 2: Convert `candidate_specs.py` to a package**

Move `services/torghut/app/trading/discovery/candidate_specs.py` to:

```text
services/torghut/app/trading/discovery/candidate_specs/__init__.py
```

Create:

```text
services/torghut/app/trading/discovery/candidate_specs/models.py
services/torghut/app/trading/discovery/candidate_specs/profile_params.py
services/torghut/app/trading/discovery/candidate_specs/execution_profiles.py
services/torghut/app/trading/discovery/candidate_specs/mechanism_overlays.py
services/torghut/app/trading/discovery/candidate_specs/family_scoring.py
services/torghut/app/trading/discovery/candidate_specs/compiler.py
services/torghut/app/trading/discovery/candidate_specs/serialization.py
```

Keep public imports in `__init__.py`:

```python
from app.trading.discovery.candidate_specs.compiler import compile_candidate_specs
from app.trading.discovery.candidate_specs.models import CandidateSpec
from app.trading.discovery.candidate_specs.serialization import candidate_spec_from_payload, candidate_spec_id_for_payload
```

- [ ] **Step 3: Convert `research_sleeves.py` to a package**

Move `services/torghut/app/trading/research_sleeves.py` to:

```text
services/torghut/app/trading/research_sleeves/__init__.py
```

Create:

```text
services/torghut/app/trading/research_sleeves/common.py
services/torghut/app/trading/research_sleeves/breakout_continuation.py
services/torghut/app/trading/research_sleeves/end_of_day_reversal.py
services/torghut/app/trading/research_sleeves/late_day_continuation.py
services/torghut/app/trading/research_sleeves/mean_reversion_exhaustion.py
services/torghut/app/trading/research_sleeves/mean_reversion_rebound.py
services/torghut/app/trading/research_sleeves/momentum_pullback.py
services/torghut/app/trading/research_sleeves/washout_rebound.py
```

Keep public evaluator imports in `__init__.py`.

- [ ] **Step 4: Convert `policy_checks.py` to a package**

Move `services/torghut/app/trading/autonomy/policy_checks.py` to:

```text
services/torghut/app/trading/autonomy/policy_checks/__init__.py
```

Create:

```text
services/torghut/app/trading/autonomy/policy_checks/artifacts.py
services/torghut/app/trading/autonomy/policy_checks/benchmark_parity.py
services/torghut/app/trading/autonomy/policy_checks/deeplob_bdlob.py
services/torghut/app/trading/autonomy/policy_checks/foundation_router.py
services/torghut/app/trading/autonomy/policy_checks/jangar_dependency.py
services/torghut/app/trading/autonomy/policy_checks/profitability_stage.py
services/torghut/app/trading/autonomy/policy_checks/promotion.py
services/torghut/app/trading/autonomy/policy_checks/rollback.py
```

Keep public API imports:

```python
from app.trading.autonomy.policy_checks.promotion import PromotionPrerequisiteResult, evaluate_promotion_prerequisites
from app.trading.autonomy.policy_checks.rollback import RollbackReadinessResult, evaluate_rollback_readiness
```

- [ ] **Step 5: Validate runtime hotspot splits**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_submission_council.py tests/test_candidate_specs.py tests/test_policy_checks.py tests/test_autonomous_lane.py -q
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen ruff check app/trading/submission_council app/trading/discovery/candidate_specs app/trading/research_sleeves app/trading/autonomy/policy_checks tests/test_submission_council.py tests/test_candidate_specs.py tests/test_policy_checks.py
uv run --frozen pylint app/trading/submission_council app/trading/discovery/candidate_specs app/trading/research_sleeves app/trading/autonomy/policy_checks --disable=all --enable=too-many-lines --score=n
```

Expected: import paths still work and all modules are below `1000` lines.

- [ ] **Step 6: Commit runtime hotspot split**

Run:

```bash
git add services/torghut/app/trading/submission_council services/torghut/app/trading/discovery/candidate_specs services/torghut/app/trading/research_sleeves services/torghut/app/trading/autonomy/policy_checks services/torghut/tests
git commit -m "refactor(torghut): modularize trading runtime hotspots"
```

## Task 10: Split Scheduler, Whitepaper Workflow, and Remaining Oversized Files

**Files:**
- Modify: `services/torghut/app/trading/scheduler/pipeline.py`
- Modify: `services/torghut/app/trading/scheduler/simple_pipeline.py`
- Modify: `services/torghut/app/whitepapers/workflow.py`
- Modify every remaining Python file reported over `1000` lines.

- [ ] **Step 1: Split scheduler pipeline helpers**

Create:

```text
services/torghut/app/trading/scheduler/pipeline_context.py
services/torghut/app/trading/scheduler/pipeline_warmup.py
services/torghut/app/trading/scheduler/pipeline_decisions.py
services/torghut/app/trading/scheduler/pipeline_submissions.py
services/torghut/app/trading/scheduler/pipeline_reconciliation.py
```

Move helper functions out of `pipeline.py` while keeping `TradingPipeline` as the public class.

- [ ] **Step 2: Split simple pipeline implementation**

Create:

```text
services/torghut/app/trading/scheduler/simple_pipeline_config.py
services/torghut/app/trading/scheduler/simple_pipeline_decisions.py
services/torghut/app/trading/scheduler/simple_pipeline_proofs.py
services/torghut/app/trading/scheduler/simple_pipeline_submission.py
```

Keep `SimpleTradingPipeline` as the public class and delegate to the new modules.

- [ ] **Step 3: Split whitepaper workflow**

Create:

```text
services/torghut/app/whitepapers/config.py
services/torghut/app/whitepapers/github_events.py
services/torghut/app/whitepapers/object_store.py
services/torghut/app/whitepapers/issue_kickoff.py
services/torghut/app/whitepapers/manual_approval.py
services/torghut/app/whitepapers/kafka_ingest.py
services/torghut/app/whitepapers/kafka_worker.py
```

Keep `services/torghut/app/whitepapers/workflow.py` as a public compatibility module that imports stable APIs from the new modules.

- [ ] **Step 4: Iterate remaining files**

Run this after every split:

```bash
cd services/torghut
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
```

For each remaining `C0302`, split by responsibility and rerun the touched tests before moving to the next file.

- [ ] **Step 5: Validate scheduler and whitepaper changes**

Run:

```bash
cd services/torghut
uv run --frozen pytest tests/test_trading_pipeline.py tests/test_start_historical_simulation.py tests/test_whitepaper_workflow.py tests/test_whitepaper_api.py -q
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen ruff check app/trading/scheduler app/whitepapers tests/test_trading_pipeline.py tests/test_whitepaper_api.py
```

If `tests/test_whitepaper_workflow.py` does not exist in the active tree, replace it with the current whitepaper workflow test files discovered by:

```bash
cd services/torghut
rg -l "WhitepaperWorkflowService|WhitepaperKafkaWorker|whitepaper_workflow" tests
```

- [ ] **Step 6: Commit remaining oversized-file splits**

Run:

```bash
git add services/torghut/app services/torghut/scripts services/torghut/tests
git commit -m "refactor(torghut): finish oversized module split"
```

## Task 11: Flip Pylint to Strict Blocking

**Files:**
- Modify: `.github/workflows/torghut-ci.yml`
- Modify: `services/torghut/README.md`
- Modify: `docs/torghut/tech-debt/file-length-inventory-2026-06-12.md`

- [ ] **Step 1: Confirm zero oversized Python files**

Run:

```bash
cd services/torghut
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
```

Expected: exit code `0`.

- [ ] **Step 2: Make Pylint file length blocking in CI**

Ensure `.github/workflows/torghut-ci.yml` has this blocking step in `static-guards`:

```yaml
      - name: Pylint file length
        working-directory: services/torghut
        run: uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
```

- [ ] **Step 3: Add blocking design gate for app and scripts**

Add this after the file-length step:

```yaml
      - name: Pylint design complexity
        working-directory: services/torghut
        run: uv run --frozen pylint app scripts --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n
```

If this fails on remaining complex functions, split those functions before committing this step.

- [ ] **Step 4: Remove the non-blocking design scan**

Delete the earlier non-blocking `Pylint design scan (non-blocking)` step from `quality-signals` after the blocking design gate passes.

- [ ] **Step 5: Update inventory as closed**

Append to `docs/torghut/tech-debt/file-length-inventory-2026-06-12.md`:

```markdown
## Closure

Final check:

```bash
cd services/torghut
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
```

Result: passed with zero `C0302` violations.
```

- [ ] **Step 6: Commit strict gate**

Run:

```bash
git add .github/workflows/torghut-ci.yml services/torghut/README.md docs/torghut/tech-debt/file-length-inventory-2026-06-12.md
git commit -m "ci(torghut): enforce strict pylint size gates"
```

## Task 12: Full Local and Remote Validation

**Files:**
- No new files.
- Validate all files changed by Tasks 1 through 11.

- [ ] **Step 1: Run full local static validation**

Run:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen python -m compileall app scripts
uv run --frozen ruff format --check app tests scripts migrations
uv run --frozen ruff check app tests scripts migrations
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
uv run --frozen pylint app scripts --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Expected: all commands pass.

- [ ] **Step 2: Run full local test and coverage validation**

Run:

```bash
cd services/torghut
uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml
uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90
```

Expected: pytest passes, branch coverage remains above configured threshold, changed-file coverage is at least `90`.

- [ ] **Step 3: Run repo-level safety checks**

Run:

```bash
cd /Users/gregkonush/.codex/worktrees/ccea/lab
git diff --check
bun run lint:argocd
```

Expected: both pass.

- [ ] **Step 4: Push and open the PR with the repo template**

Run:

```bash
git push -u origin codex/torghut-pylint-file-length-gate-20260612
tmp_body="$(mktemp)"
cp .github/PULL_REQUEST_TEMPLATE.md "$tmp_body"
```

Fill the template with exact shipped changes and validation results. Scan for placeholders:

```bash
rg -n "TODO|TBD|<|>|\\[ \\]" "$tmp_body"
```

Expected: no placeholder output remains after editing.

Create the PR:

```bash
gh pr create \
  --repo proompteng/lab \
  --title "refactor(torghut): enforce pylint module size gates" \
  --body-file "$tmp_body"
```

- [ ] **Step 5: Wait for checks**

Run:

```bash
gh pr checks --repo proompteng/lab --watch
```

Expected: all mandatory checks are green before reporting the PR ready.

## Execution Strategy

Use stacked or sequential PRs rather than one giant review if the diff becomes too large:

1. Pylint dependency and inventory.
2. App main compatibility and API test split.
3. Whitepaper autoresearch script and tests.
4. Runtime-window import script and tests.
5. Historical simulation and frontier scripts.
6. Runtime app hotspots.
7. Scheduler and whitepaper workflow.
8. Final strict blocking gate.

Each PR must leave the repository in a releasable state. Do not merge a PR that only moves half of an import path or leaves a wrapper pointing at missing code.

## Self-Review

- Spec coverage: Pylint install, strict rules, giant-file refactor, modularization, and tech-debt closure are each covered by tasks.
- Placeholder scan: the plan contains concrete paths, commands, and module boundaries. Implementation steps that move existing code name the exact source and destination families.
- Type consistency: Pylint config uses `[tool.pylint.format] max-module-lines = 1000`, matching the Pylint docs for `C0302`.
- Risk controls: compatibility tests precede `app.main` extraction; CI gates are flipped to blocking only after refactors pass locally.
