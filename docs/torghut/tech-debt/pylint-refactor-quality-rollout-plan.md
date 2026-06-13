# Torghut Refactor Quality and Pylint Enforcement Plan

## Purpose

This plan turns the Torghut Pylint rollout into an enforceable quality program. It closes the gaps that allowed generated split modules, dynamic compatibility facades, blanket type/lint suppressions, and wildcard re-export test wrappers to pass review while still satisfying the original hard target: every scoped Python file under 1000 lines and final Pylint size/design gates in CI.

## Current Evidence

Snapshot from the current worktree on June 13, 2026:

- Python files under `services/torghut/app`, `scripts`, `tests`, and `migrations`: 1558.
- Files currently over 1000 lines: 0.
- Generated split files still present: 408.
- Files containing file-level Pyright suppressions: 461.
- Files containing file-level Ruff `noqa`: 744.
- Files containing `globals().update`: 72.
- Files containing `CompatModule`: 62.
- Files containing wildcard imports: 571.
- Files containing `# type: ignore`: 67.

The current enforcement is incomplete:

- Pyright is strict for `app` through `pyrightconfig.json`, but `app/trading/alpha` and `scripts` are still basic profiles with multiple diagnostics disabled.
- Pylint blocks `too-many-lines` at 1000 lines, but design-complexity checks are still non-blocking inventory.
- Ruff blocks format and the configured lint set, but Ruff/Pylint/Pyright do not understand Torghut-specific anti-patterns such as `source_part_07.py`, dynamic module facades, or generated compatibility packages.

## External Tool Guidance

- Pylint `too-many-lines` (`C0302`) exists specifically because oversized modules become harder to read, navigate, and maintain: <https://pylint.readthedocs.io/en/latest/messages/convention/too-many-lines.html>.
- Pyright supports `typeCheckingMode` values including `strict`; strict mode enables most type-checking rules, while basic mode is materially weaker: <https://github.com/microsoft/pyright/blob/main/docs/configuration.md>.
- Ruff supports file-level `# ruff: noqa`, so the repo must explicitly ban broad file suppressions where they hide refactor fallout: <https://docs.astral.sh/ruff/linter/>.
- Python PEP 8 says wildcard imports should be avoided because they obscure which names are present and confuse readers and automated tools: <https://peps.python.org/pep-0008/#imports>.

## Non-Negotiable Rules

1. No generated split filenames in changed Torghut Python files:
   - banned: `part_*`, `source_part_*`, `test_part_*`, numeric source shards, and source-offset names such as `statements_3342`.
   - required: responsibility names such as `runtime_health.py`, `artifact_verification.py`, `portfolio_selection.py`, `schema_registry.py`, or `target_plan_import.py`.

2. No dynamic compatibility facades:
   - banned: `globals().update(...)`, custom `ModuleType` wrappers, module-level `__getattr__` or `__setattr__`, `sys.modules[...]` replacement, module class mutation, and dynamic `__all__` generated from `globals()`.
   - allowed: explicit, named facade functions that delegate to implementation modules and have tests for legacy patch/import paths.

3. No blanket static-check suppressions:
   - banned in changed files: file-level `# pyright: ...=false`, file-level `# ruff: noqa`, broad `# noqa`, `# type: ignore`, and `# pylint: disable=too-many-lines`.
   - allowed only by exception: line-scoped suppressions with a concrete rule code and a short reason, reviewed in the PR.

4. No wildcard imports in changed Python files:
   - imports must name the objects they use.
   - package public APIs must define explicit imports and explicit `__all__`.

5. Compatibility is a tested contract, not a module hack:
   - legacy wrappers must be thin and explicit.
   - any patched public target must have tests proving patch propagation without dynamic module mutation.

## Enforcement Architecture

### Immediate Guard

Add and keep a blocking changed-file guard in `services/torghut/scripts/check_refactor_quality.py`.

The guard must fail changed Python files that introduce:

- generated split filenames,
- `globals().update`,
- `CompatModule`/compat registries,
- module-level dynamic attribute hooks,
- `sys.modules` replacement or class mutation,
- dynamic `__all__` generated from `globals()`,
- file-level Pyright/Ruff/Pylint suppressions,
- `# type: ignore`,
- wildcard imports.

This guard is changed-file scoped at first because `main` still contains legacy violations. It prevents new slop immediately while cleanup proceeds.

### Global Guard Promotion

After each violation class reaches zero in the scoped paths, flip the guard from changed-file mode to global mode in CI:

```bash
uv run --frozen python scripts/check_refactor_quality.py --all
```

Promotion order:

1. generated split filenames,
2. dynamic compatibility facades,
3. blanket Pyright suppressions,
4. blanket Ruff suppressions and wildcard imports,
5. remaining line-scoped suppression audit.

### Static Tool Strictness

Pylint:

- Keep `max-module-lines = 1000` blocking for `app scripts tests migrations`.
- Block changed `app scripts` files immediately for focused design rules:
  - `too-many-arguments`,
  - `too-many-positional-arguments`,
  - `too-many-branches`,
  - `too-many-locals`,
  - `too-many-return-statements`,
  - `too-many-statements`,
  - `too-many-nested-blocks`.
- Flip the same design checks from changed-file blocking to global blocking once current design debt is remediated.
- Do not enable full default Pylint as a surprise gate; add focused rules only when the branch also cleans the corresponding debt.

Pyright:

- Keep `app` strict.
- Move `scripts` from `basic` toward `strict` by packages, not by blanket suppressions.
- Add strict include blocks for cleaned script packages after their facades and imports are explicit.
- Remove file-level `# pyright: ...=false` before claiming any module is clean.

Ruff:

- Keep blocking `ruff format --check` and `ruff check`.
- Add rule selection deliberately in tranches:
  - import hygiene (`F401`, `F403`, `F405`) by eliminating wildcard re-export wrappers,
  - complexity (`C901`) after structural splits,
  - security (`S`) after test fixtures and false positives are line-scoped.

## Refactor Method

Use this process for every generated module package:

1. Inventory public imports and patch targets with `rg`.
2. Add or update compatibility tests before moving behavior.
3. Rename files by responsibility.
4. Replace wildcard imports with explicit imports.
5. Replace dynamic wrappers with explicit facades or direct imports.
6. Run focused tests for that surface.
7. Run Ruff, compileall, Pylint file-length, and the refactor quality guard.
8. Run all three Pyright profiles before PR creation.
9. Push only after local validation is green.

Do not split code by line number. Split by ownership:

- constants/config schema,
- parsing,
- external I/O,
- persistence,
- orchestration,
- validation,
- reporting/artifacts,
- CLI entrypoints.

## Cleanup Tranches

### Tranche 1: Guard and Verification Cleanup

Scope:

- `scripts/check_refactor_quality.py`
- `.github/workflows/torghut-ci.yml`
- `scripts/historical_simulation_verification.py`
- `scripts/historical_simulation_verification_modules/*`
- focused guard and historical verification tests

Acceptance:

- no generated names in the touched package,
- no `globals().update`,
- no custom module mutation,
- no dynamic `__all__`,
- no file-level Pyright/Ruff suppressions,
- changed-file Pylint design gate passes for the touched `app scripts` files,
- existing patch targets still work.

### Tranche 2: Config and Settings Package

Scope:

- `app/config.py`
- `app/config_modules/*`
- `app/config.pyi`
- config-focused tests and scheduler tests that mutate `app.config.settings`

Target module names:

- `settings_base.py`
- `core_settings.py`
- `trading_settings.py`
- `risk_settings.py`
- `llm_settings.py`
- `normalization.py`
- `validation.py`

Acceptance:

- no generated filenames,
- no dynamic `app.config` replacement,
- explicit settings exports,
- all `from app import config` and `from app.config import Settings, settings` paths stable.

### Tranche 3: Scheduler Packages

Scope:

- `app/trading/scheduler/pipeline_modules`
- `state_modules`
- `source_collection_modules`
- `submission_preparation_modules`
- `paper_route_probe_modules`
- matching `tests/pipeline/*`

Target module names:

- `pipeline_state.py`,
- `source_collection.py`,
- `submission_preparation.py`,
- `paper_route_probe.py`,
- `runtime_migrations.py`,
- `target_plan_materialization.py`,
- `health_signals.py`.

Acceptance:

- no `CompatModule`,
- no wildcard module stitching,
- scheduler patch tests updated to explicit public targets.

### Tranche 4: Runtime Window Import

Scope:

- `app/trading/runtime_window_import_modules`
- `scripts/import_hypothesis_runtime_windows_modules`
- runtime-window tests

Target module names:

- `window_bounds.py`,
- `source_rows.py`,
- `lineage.py`,
- `costs.py`,
- `materialization.py`,
- `audit.py`,
- `cli.py`.

Acceptance:

- runtime-ledger behavior unchanged,
- source-kind authority and fail-closed proof semantics preserved,
- no blanket Pyright/Ruff suppressions.

### Tranche 5: Whitepaper and Autoresearch

Scope:

- `app/whitepapers/workflow_modules`
- `app/whitepapers/claim_compiler_modules`
- `scripts/run_whitepaper_autoresearch_profit_target_modules`
- related tests

Target module names:

- `claim_parsing.py`,
- `claim_graph.py`,
- `workflow_storage.py`,
- `workflow_orchestration.py`,
- `epoch_selection.py`,
- `portfolio_outputs.py`,
- `promotion_artifacts.py`,
- `runner_cli.py`.

Acceptance:

- script entrypoint remains stable,
- workflow service behavior covered by focused tests,
- no generated source shards.

### Tranche 6: Trading Discovery and Runtime Hotspots

Scope:

- candidate specs,
- research sleeves,
- fast replay,
- evidence bundles,
- runtime closure,
- portfolio optimizer,
- policy checks,
- submission council.

Acceptance:

- explicit public exports,
- no wildcard test wrappers,
- design-complexity violations reduced enough to enable blocking Pylint design gate.

### Tranche 7: Test Wrapper Cleanup

Scope:

- `tests/**/test_part_*`
- root `tests/test_*.py` wildcard aggregators
- support modules with file-level Ruff suppressions

Policy:

- Prefer real pytest discovery in domain folders.
- Delete aggregator wrappers when direct files are collected.
- Keep support modules explicit and named.

Acceptance:

- no `test_part_*` in touched domains,
- no wildcard import aggregators,
- coverage remains equivalent or better.

### Tranche 8: Global Enforcement Flip

Scope:

- `scripts/check_refactor_quality.py --all`
- blocking Pylint design gate for `app scripts`
- final Pyright profile tightening plan for remaining basic-only areas

Acceptance:

- zero generated split files,
- zero dynamic compat facades,
- zero blanket Pyright/Ruff suppressions in scoped paths,
- zero wildcard imports in scoped paths except explicitly documented public API exceptions, if any.

## PR Discipline

- Branch every tranche from fresh `origin/main`.
- Make PRs large enough to remove a whole offender class in a domain, not one-file cosmetic patches.
- Do not open a PR with known local guard, Ruff, compile, or focused test failures.
- Use the repo PR template and list exact validation commands.
- Merge only after required GitHub checks are green.

## Required Validation Per Tranche

Minimum local validation:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen python scripts/check_refactor_quality.py
uv run --frozen python -m compileall app scripts
uv run --frozen ruff format --check app tests scripts migrations
uv run --frozen ruff check app tests scripts migrations
uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n
uv run --frozen pyright --project pyrightconfig.json
uv run --frozen pyright --project pyrightconfig.alpha.json
uv run --frozen pyright --project pyrightconfig.scripts.json
```

Targeted tests:

- run the focused domain tests for the package being cleaned,
- run compatibility tests for legacy imports and patch targets,
- run changed-line coverage after coverage XML exists.

Final validation before global enforcement:

```bash
cd services/torghut
uv run --frozen python scripts/check_refactor_quality.py --all
uv run --frozen pylint app scripts --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n
uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml
uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90
cd /Users/gregkonush/.codex/worktrees/ccea/lab
git diff --check
bun run lint:argocd
```

## Completion Definition

The rollout is done only when current evidence proves:

- every scoped Python file is under 1000 lines,
- `check_refactor_quality.py --all` passes,
- Pylint file-length gate is blocking and green,
- Pylint design gate is blocking and green for `app scripts`,
- all three Pyright profiles pass without adding new blanket suppressions,
- Ruff format/check pass,
- tests and coverage pass,
- CI is green,
- no dynamic compatibility facade remains in `app`, `scripts`, `tests`, or `migrations`.
