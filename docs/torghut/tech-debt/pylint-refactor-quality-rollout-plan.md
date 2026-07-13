# Torghut Refactor Quality and Pylint Enforcement Plan

## Purpose

This plan turns the Torghut Pylint rollout into an enforceable quality program. It closes the gaps that allowed generated split modules, dynamic compatibility facades, blanket type/lint suppressions, and wildcard re-export test wrappers to pass review while still satisfying the original hard target: every scoped Python file under 1000 lines and final Pylint size/design gates in CI.

## Current Evidence

Snapshot from the current worktree on July 12, 2026 (audit of live code vs. June 13 docs):

- Python files under `services/torghut/app`, `scripts`, `tests`, and `migrations`: 1553.
- Files over 1000 lines: 0 (largest is exactly 1000).
- Generated split files in source: 0 (only `__pycache__` remnants remain).
- File-level Pyright suppressions in source: 0 (`app/` clean; a few `noqa: E402` in scripts for import ordering).
- File-level Ruff `noqa` in source: 0 (`app/` clean; 3 `noqa: E402` in scripts).
- `globals().update` in source: 0 (checker tool references only).
- `CompatModule` in source: 0 (checker tool + one negative test reference only).
- Wildcard imports in source: 0.
- `# type: ignore` in source: 0.
- Pylint design-complexity findings: ~638 across ~315 files in `app/` and `scripts/`.
- Breakdown: `too-many-locals` ~415, `too-many-branches` ~116, `too-many-statements` ~107, `too-many-return-statements` ~0.
- Pyright strict: `app/` only. `scripts/` and `app/trading/alpha/` still on basic profiles.

The remaining enforcement gaps are:

- Pylint design-complexity checks (`too-many-locals`, `too-many-branches`, `too-many-statements`) are non-blocking inventory. Refactoring by responsibility is needed before the gate can flip to blocking.
- Pyright is strict for `app/` only. `scripts/` and `app/trading/alpha/` remain on basic profiles with 10 diagnostics disabled each.
- Two files sit exactly at 1000 lines with zero margin for regression: `scripts/consistent_profitability_frontier/paper_probation.py` and `migrations/versions/0059_broker_mutation_receipts.py`.

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

### Current Phase (2026-07-12)

All anti-pattern suppressions and generated split files have been removed from source.
Promotion order is complete through step 4. The remaining work:

1. ~~generated split filenames~~ → **Resolved** (0 in source)
2. ~~dynamic compatibility facades~~ → **Resolved** (0 in source)
3. ~~blanket Pyright suppressions~~ → **Resolved** (0 in `app/`; `noqa: E402` only in scripts)
4. ~~blanket Ruff suppressions and wildcard imports~~ → **Resolved** (0 in source)
5. Design-complexity refactoring → **Current work**
6. Pyright strictness tightening for `scripts/` and `app/trading/alpha/` → **Current work**
7. Remaining line-scoped suppression audit → **Current work**

Next command: `uv run --frozen python scripts/check_refactor_quality.py --all`

### Global Guard Promotion

After each violation class reaches zero in the scoped paths, flip the guard from changed-file mode to global mode in CI:

```bash
uv run --frozen python scripts/check_refactor_quality.py --all
```

Promotion order (legacy list, superseded by current phase):

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

> Note: Tranches 1–7 (anti-pattern cleanup) are resolved. All generated split files, wildcard imports, `globals().update`, `CompatModule`, and file-level suppressions have been removed from source. The remaining tranches focus on design-complexity refactoring and Pyright strictness.

### Tranche 1–7: Anti-Pattern Cleanup

**Status: Complete.**
- 0 generated split filenames in source (only `__pycache__` remnants)
- 0 wildcard imports in source
- 0 `globals().update` in source
- 0 `CompatModule` in source
- 0 file-level Pyright/Ruff/Pylint suppressions in `app/`
- `check_refactor_quality.py` guard is committed and passing

### Current Tranche: Design-Complexity Refactoring

Scope: All files with Pylint `too-many-locals`, `too-many-branches`, or `too-many-statements` violations (~315 files, ~638 findings). Prioritize high-frequency offenders first.

Method: Split by **ownership/responsibility**, not by line number:
- constants/config schema
- parsing
- external I/O
- persistence
- orchestration
- validation
- reporting/artifacts
- CLI entrypoints

Do NOT use `part_*`, `source_part_*`, or `test_part_*` filenames. Use responsibility names like `runtime_health.py`, `claim_parsing.py`, `portfolio_selection.py`.

### Tranche 8: Pyright Strictness + Global Enforcement Flip

Scope:

- `scripts/check_refactor_quality.py --all`
- blocking Pylint design gate for `app scripts` (after complexity refactoring reduces findings)
- Pyright profile tightening:
  - `scripts/`: move from `basic` toward `strict` by package
  - `app/trading/alpha/`: move from `basic` toward `strict`

Acceptance:

- zero generated split files in source,
- zero dynamic compat facades in source,
- zero blanket Pyright/Ruff suppressions in scoped paths,
- zero wildcard imports in scoped paths except explicitly documented public API exceptions, if any,
- all three Pyright profiles pass without new blanket suppressions,
- Pylint design gate is blocking and green for `app scripts`.

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
cd <repo-root>
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
