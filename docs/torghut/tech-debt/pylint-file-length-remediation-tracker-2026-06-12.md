# Torghut Pylint File Length & Quality Remediation Tracker

Date: 2026-06-12
Updated: 2026-07-12
Branch: `codex/torghut-pylint-file-length-gate-20260612`
Base: `origin/main` at `e2170165c`

## Status Overview (2026-07-12 code audit)

All file-length debt is resolved. All anti-pattern suppressions (wildcard imports, `globals().update`, `CompatModule`, file-level `# noqa`/`# type: ignore`/`# pyright: false`) have been removed from source in `app/`, `scripts/`, `tests/`, and `migrations/`. The remaining debt is **design-complexity** (Pylint `too-many-locals`, `too-many-branches`, `too-many-statements`) and **Pyright strictness** for `scripts/` and `app/trading/alpha/`.

Current numbers verified against live code:

| Metric | Docs Claim (June 13) | Actual (July 12) | Status |
|---|---|---|---|
| Files over 1000 lines | 0 | 0 | ✅ Resolved |
| Generated `part_*` source files | 408 | 0 (only `__pycache__` remnants) | ✅ Resolved |
| Wildcard imports | 571 | 0 | ✅ Resolved |
| `globals().update` | 72 | 0 in source (checker tool references only) | ✅ Resolved |
| `CompatModule` | 62 | 0 in source (checker tool references only) | ✅ Resolved |
| File-level suppressions (`# noqa`, `# type: ignore`, `pyright: false`) | 1,205 | 0 in `app/`; 3 `noqa: E402` in scripts (import ordering) | ✅ Resolved |
| Design-complexity findings | 826 across 340 files | ~638 across 315 files | 🟡 In progress |
| `too-many-locals` | 461 | ~415 | 🟡 In progress |
| `too-many-branches` | 139 | ~116 | 🟡 In progress |
| `too-many-statements` | 122 | ~107 | 🟡 In progress |
| `too-many-return-statements` | 104 | ~0 | ✅ Resolved |
| Pyright strict (`app/`) | strict | strict | ✅ |
| Pyright basic (`scripts/`) | basic | basic | 🟡 |
| Pyright basic (`app/trading/alpha/`) | basic | basic | 🟡 |

The file-length gate and refactoring-quality guard are complete and passing. The next tranche focuses on design-complexity refactoring and Pyright profile tightening.

## Objective

Make Torghut enforce Pylint module-size rules in CI and remove the oversized-file debt by splitting code and tests into focused modules. The final state is zero scoped Python files over `1000` lines, no `too-many-lines` suppressions, and all Torghut static/test gates green.

## Final Acceptance

- `uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n` passes from `services/torghut`.
- `uv run --frozen pylint app scripts --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n` passes from `services/torghut`.
- `uv run --frozen ruff check app tests scripts migrations` passes.
- `uv run --frozen pyright --project pyrightconfig.json` passes.
- `uv run --frozen pyright --project pyrightconfig.alpha.json` passes.
- `uv run --frozen pyright --project pyrightconfig.scripts.json` passes.
- `uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml` passes.
- `uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90` passes.
- `git diff --check` passes.
- CI is green before merge.

## Work Breakdown

| Tranche | Status | Scope | Required result |
| --- | --- | --- | --- |
| 1 | Complete | Add Pylint dependency/config/docs/inventory | Pylint installed and runnable, inventory committed |
| 2 | Complete | CI visibility and final gate scaffold | CI logs current debt and has ready blocking Pylint step |
| 3 | Complete | `app.main` compatibility tests | Legacy patch/import targets protected before extraction |
| 4 | Complete | `app/main.py` app assembly split | `app.main` becomes thin assembly + compatibility module |
| 5 | Complete | API tests split | `test_trading_api.py` split below 1000 lines |
| 6 | Complete | Whitepaper autoresearch script/tests | Runner package + tests below 1000 lines |
| 7 | Complete | Runtime-window import script/tests | Import package + tests below 1000 lines |
| 8 | Complete | Historical simulation and frontier scripts/tests | Script packages + tests below 1000 lines |
| 9 | Complete | Trading runtime hotspots | `submission_council`, `candidate_specs`, `research_sleeves`, `policy_checks` modularized |
| 10 | Complete | Scheduler, whitepaper workflow, remaining files | Every remaining scoped Python file below 1000 lines |
| 11 | Blocked for design | Strict CI flip | Blocking file-length gate is ready; design gate still has legacy findings |
| 12 | In progress | Full validation + PR | Local size/static/test checks green; design gate not green |

## Current Largest Scoped Files

Inventory command last run locally on 2026-06-12 after the full split. Current scoped total: `565286` Python lines
across `1526` files in `app`, `scripts`, `tests`, and `migrations`. No scoped Python file is over `1000` lines.

| Lines | File |
| ---: | --- |
| 999 | `services/torghut/tests/profitability_frontier/test_search_frontier_ledger_args.py` |
| 999 | `services/torghut/tests/policy_checks/test_policy_checks_manifest_b.py` |
| 993 | `services/torghut/tests/test_evidence_epochs.py` |
| 993 | `services/torghut/app/options_lane/repository.py` |
| 992 | `services/torghut/app/trading/evidence_clock_arbiter.py` |
| 986 | `services/torghut/app/trading/forecasting.py` |
| 985 | `services/torghut/app/trading/routeability_repair_acceptance.py` |
| 984 | `services/torghut/scripts/inspect_hpairs_runtime_evidence.py` |
| 984 | `services/torghut/app/trading/discovery/autoresearch_notebooks.py` |
| 983 | `services/torghut/tests/test_execution_adapters.py` |
| 983 | `services/torghut/tests/decisions/test_decision_engine_overlays.py` |
| 981 | `services/torghut/tests/historical_simulation/test_start_historical_simulation_lifecycle_c.py` |
| 975 | `services/torghut/tests/test_session_context.py` |
| 974 | `services/torghut/tests/whitepaper_autoresearch/test_autoresearch_runner_sources_replay.py` |
| 967 | `services/torghut/tests/decisions/test_decision_engine_positions.py` |

## First-Tranche Evidence

- `uv sync --frozen --extra dev` passed and installed `pylint==4.0.5`.
- `uv run --frozen ruff format --check tests/test_main_api_refactor.py` passed.
- `uv run --frozen ruff check tests/test_main_api_refactor.py` passed.
- `uv run --frozen pytest tests/test_main_api_refactor.py -q` passed: 9 tests.
- `uv run --frozen pylint tests/test_main_api_refactor.py --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pylint tests/test_trading_api.py --disable=all --enable=too-many-lines --score=n` failed as expected with `C0302: Too many lines in module (10695/1000)`.
- Full-tree Pylint inventory was stopped locally after several minutes with no output; CI still carries the exact
  non-blocking future gate commands, and the deterministic `wc -l` inventory above records the debt set for refactoring.

## App Main Split Evidence

- Added `app/bootstrap.py` for auth/env helpers, lifecycle startup/shutdown, Inngest registration, SQLAlchemy exception
  handling, `healthz`, and `create_app`.
- Kept legacy `app.main` private/public names assigned from bootstrap so existing patches and imports continue to resolve.
- `app/main.py` is now `329` lines; `app/bootstrap.py` is `366` lines.
- `uv run --frozen ruff format --check app/main.py app/bootstrap.py tests/test_main_api_refactor.py` passed.
- `uv run --frozen ruff check app/main.py app/bootstrap.py tests/test_main_api_refactor.py` passed.
- `uv run --frozen pytest tests/test_main_api_refactor.py tests/test_whitepaper_api.py tests/test_trading_proofs_api.py -q` passed: 20 tests.
- `uv run --frozen pyright --project pyrightconfig.json` passed.
- `uv run --frozen pyright --project pyrightconfig.alpha.json` passed.
- `uv run --frozen pyright --project pyrightconfig.scripts.json` passed.

## Trading API Test Split Evidence

- Replaced the `10695`-line `tests/test_trading_api.py` with a 26-line import smoke test.
- Added `tests/api/trading_api_support.py` for shared fixtures/helpers at `650` lines after formatting.
- Added endpoint-family test modules under `tests/api`; largest replacement file is below `1000` lines.
- `uv run --frozen ruff format --check tests/test_trading_api.py tests/api` passed.
- `uv run --frozen ruff check tests/test_trading_api.py tests/api` passed.
- `uv run --frozen pytest tests/test_trading_api.py tests/api -q` passed: 166 tests.
- `uv run --frozen pylint tests/test_trading_api.py tests/api --disable=all --enable=too-many-lines --score=n` passed.

## Trading Pipeline Test Split Evidence

- Replaced the `25175`-line `tests/test_trading_pipeline.py` with a 45-line import smoke test.
- Added `tests/pipeline/trading_pipeline_support.py` and `tests/pipeline/trading_pipeline_base.py` for shared helpers and
  `TestCase` setup.
- Added domain-family pipeline test modules under `tests/pipeline`; largest replacement file is below `1000` lines.
- `uv run --frozen ruff format --check tests/test_trading_pipeline.py tests/pipeline` passed.
- `uv run --frozen ruff check tests/test_trading_pipeline.py tests/pipeline` passed.
- `uv run --frozen pytest tests/test_trading_pipeline.py tests/pipeline -q` passed: 284 tests.
- `uv run --frozen pylint tests/test_trading_pipeline.py tests/pipeline --disable=all --enable=too-many-lines --score=n` passed.

## Whitepaper Autoresearch Test Split Evidence

- Replaced the `13613`-line `tests/test_run_whitepaper_autoresearch_profit_target.py` with a 29-line import smoke test.
- Added `tests/whitepaper_autoresearch/autoresearch_runner_support.py` and
  `tests/whitepaper_autoresearch/autoresearch_runner_base.py` for shared helpers and `TestCase` setup.
- Added whitepaper autoresearch domain test modules under `tests/whitepaper_autoresearch`; largest replacement file is
  below `1000` lines.
- `uv run --frozen ruff format --check tests/test_run_whitepaper_autoresearch_profit_target.py tests/whitepaper_autoresearch` passed.
- `uv run --frozen ruff check tests/test_run_whitepaper_autoresearch_profit_target.py tests/whitepaper_autoresearch` passed.
- `uv run --frozen pylint tests/test_run_whitepaper_autoresearch_profit_target.py tests/whitepaper_autoresearch --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pytest tests/test_run_whitepaper_autoresearch_profit_target.py tests/whitepaper_autoresearch -q` passed: 185 tests.

## Runtime Window Import Test Split Evidence

- Replaced the `11503`-line `tests/test_import_hypothesis_runtime_windows.py` with a 27-line import smoke test.
- Added shared support/base modules under `tests/runtime_window_import`.
- Added runtime-window import domain test modules under `tests/runtime_window_import`; largest replacement file is below
  `1000` lines.
- `uv run --frozen ruff format --check tests/test_import_hypothesis_runtime_windows.py tests/runtime_window_import` passed.
- `uv run --frozen ruff check tests/test_import_hypothesis_runtime_windows.py tests/runtime_window_import` passed.
- `uv run --frozen pylint tests/test_import_hypothesis_runtime_windows.py tests/runtime_window_import --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pytest tests/test_import_hypothesis_runtime_windows.py tests/runtime_window_import -q` passed: 152 tests.

## Historical Simulation Test Split Evidence

- Replaced the `9942`-line `tests/test_start_historical_simulation.py` with a 27-line import smoke test.
- Added shared support/base modules under `tests/historical_simulation`.
- Added historical simulation domain test modules under `tests/historical_simulation`; largest replacement file is below
  `1000` lines.
- `uv run --frozen ruff check tests/test_start_historical_simulation.py tests/historical_simulation` passed.
- `uv run --frozen pylint tests/test_start_historical_simulation.py tests/historical_simulation --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pytest tests/test_start_historical_simulation.py tests/historical_simulation -q` passed: 166 tests.

## Profitability Frontier Test Split Evidence

- Replaced the `7424`-line `tests/test_search_consistent_profitability_frontier.py` with a 22-line import smoke test.
- Added shared support/base modules under `tests/profitability_frontier`.
- Added profitability frontier domain test modules under `tests/profitability_frontier`; largest replacement file is
  `999` lines.
- `uv run --frozen ruff format tests/test_search_consistent_profitability_frontier.py tests/profitability_frontier` passed.
- `uv run --frozen ruff check tests/test_search_consistent_profitability_frontier.py tests/profitability_frontier` passed.
- `uv run --frozen pylint tests/test_search_consistent_profitability_frontier.py tests/profitability_frontier --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pytest tests/test_search_consistent_profitability_frontier.py tests/profitability_frontier -q` passed: 117 tests.

## Policy Checks Module Split Evidence

- Replaced the `6425`-line `app/trading/autonomy/policy_checks.py` with a `635`-line compatibility module.
- Added validation-family implementation modules under `app/trading/autonomy/policy_check_modules`; largest replacement
  file is `956` lines.
- Preserved `PromotionPrerequisiteResult`, `RollbackReadinessResult`, `evaluate_promotion_prerequisites`,
  `evaluate_rollback_readiness`, and private helper import compatibility used by current tests.
- `uv run --frozen ruff check app/trading/autonomy/policy_checks.py app/trading/autonomy/policy_check_modules` passed.
- `uv run --frozen pylint app/trading/autonomy/policy_checks.py app/trading/autonomy/policy_check_modules --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pytest tests/test_policy_checks.py -q` passed before the test split: 90 tests.
- `uv run --frozen pytest tests/test_autonomous_lane.py -q` passed: 65 tests.

## Policy Checks Test Split Evidence

- Replaced the `6070`-line `tests/test_policy_checks.py` with a 17-line import smoke test.
- Added shared support modules and validation-family test modules under `tests/policy_checks`; largest replacement file is
  `999` lines.
- `uv run --frozen ruff check tests/test_policy_checks.py tests/policy_checks` passed.
- `uv run --frozen pylint tests/test_policy_checks.py tests/policy_checks --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pytest tests/test_policy_checks.py tests/policy_checks -q` passed: 91 tests.

## Autonomous Lane Test Split Evidence

- Replaced the `4476`-line `tests/test_autonomous_lane.py` with a 16-line import smoke test.
- Added shared support and lane evidence/governance/persistence/phase modules under `tests/autonomous_lane`; largest
  replacement file is `932` lines.
- `uv run --frozen ruff check tests/test_autonomous_lane.py tests/autonomous_lane` passed.
- `uv run --frozen pylint tests/test_autonomous_lane.py tests/autonomous_lane --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pytest tests/test_autonomous_lane.py tests/autonomous_lane -q` passed: 66 tests.

## Submission Council Split Evidence

- Replaced the `5160`-line `app/trading/submission_council.py` with a `537`-line compatibility facade.
- Added focused implementation modules under `app/trading/submission_council_modules`; largest module is under `1000`
  lines.
- Preserved legacy patch/import targets through the facade and explicit compatibility lookups.
- Replaced the `7242`-line `tests/test_submission_council.py` with a 3-line import shell.
- Added shared support and responsibility-focused tests under `tests/submission_council`; largest replacement file is
  `872` lines.
- `.venv/bin/ruff check app/trading/submission_council.py app/trading/submission_council_modules` passed.
- `.venv/bin/pylint app/trading/submission_council.py app/trading/submission_council_modules --disable=all --enable=too-many-lines --score=n` passed.
- `.venv/bin/pytest tests/test_submission_council.py tests/submission_council -q` passed: 98 tests.
- `.venv/bin/ruff check tests/test_submission_council.py tests/submission_council` passed.
- `.venv/bin/pylint tests/test_submission_council.py tests/submission_council --disable=all --enable=too-many-lines --score=n` passed.

## Strategy Runtime Test Split Evidence

- Replaced the `6657`-line `tests/test_strategy_runtime.py` with a 4-line import shell.
- Added shared support and runtime/microbar/reversion-focused test modules under `tests/strategy_runtime`; largest
  replacement file is `960` lines.
- `.venv/bin/ruff check tests/test_strategy_runtime.py tests/strategy_runtime` passed.
- `.venv/bin/pylint tests/test_strategy_runtime.py tests/strategy_runtime --disable=all --enable=too-many-lines --score=n` passed.
- `.venv/bin/pytest tests/test_strategy_runtime.py tests/strategy_runtime -q` passed: 101 tests.

## Decision Engine Test Split Evidence

- Replaced the `5595`-line `tests/test_decisions.py` with a 4-line import shell.
- Added shared support and decision-engine behavior modules under `tests/decisions`; largest replacement file is
  `984` lines.
- `.venv/bin/ruff check tests/test_decisions.py tests/decisions` passed.
- `.venv/bin/pylint tests/test_decisions.py tests/decisions --disable=all --enable=too-many-lines --score=n` passed.
- `.venv/bin/pytest tests/test_decisions.py tests/decisions -q` passed: 90 tests.

## Empirical Promotion Job Test Split Evidence

- Replaced the `5528`-line `tests/test_run_empirical_promotion_jobs.py` with a 4-line import shell.
- Added shared support and runtime-window/renewal-focused tests under `tests/run_empirical_promotion_jobs`; largest
  replacement file is `942` lines.
- `.venv/bin/ruff check tests/test_run_empirical_promotion_jobs.py tests/run_empirical_promotion_jobs` passed.
- `.venv/bin/pylint tests/test_run_empirical_promotion_jobs.py tests/run_empirical_promotion_jobs --disable=all --enable=too-many-lines --score=n` passed.
- `.venv/bin/pytest tests/test_run_empirical_promotion_jobs.py tests/run_empirical_promotion_jobs -q` passed: 84 tests.

## Order Feed Test Split Evidence

- Replaced the `5223`-line `tests/test_order_feed.py` with a 4-line import shell.
- Added shared setup/support and ingest/linking/repair/cursor/fill-delta test modules under `tests/order_feed`; largest
  replacement file is `831` lines.
- `.venv/bin/ruff check tests/test_order_feed.py tests/order_feed` passed.
- `.venv/bin/pylint tests/test_order_feed.py tests/order_feed --disable=all --enable=too-many-lines --score=n` passed.
- `.venv/bin/pytest tests/test_order_feed.py tests/order_feed -q` passed: 101 tests.

## Strategy Autoresearch Test Split Evidence

- Replaced the `4461`-line `tests/test_strategy_autoresearch.py` with a 4-line import shell.
- Added shared support and autoresearch helper/replay/program/loop/main test modules under `tests/strategy_autoresearch`;
  largest replacement file is `941` lines.
- `.venv/bin/ruff check tests/test_strategy_autoresearch.py tests/strategy_autoresearch` passed.
- `.venv/bin/pylint tests/test_strategy_autoresearch.py tests/strategy_autoresearch --disable=all --enable=too-many-lines --score=n` passed.
- `.venv/bin/pytest tests/test_strategy_autoresearch.py tests/strategy_autoresearch -q` passed: 70 tests.

## Size Gate Enforcement Evidence

- All scoped Python modules in `app`, `scripts`, `tests`, and `migrations` are now under `1000` lines.
- No `# pylint: disable=too-many-lines` suppressions were introduced.
- `.venv/bin/python -m compileall app scripts` passed.
- `.venv/bin/ruff format --check app tests scripts migrations` passed.
- `.venv/bin/ruff check app scripts tests migrations` passed.
- `.venv/bin/pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n` passed.
- `.venv/bin/pyright --project pyrightconfig.json` passed.
- `.venv/bin/pyright --project pyrightconfig.alpha.json` passed.
- `.venv/bin/pyright --project pyrightconfig.scripts.json` passed.
- `uv sync --frozen --extra dev` passed.
- `uv run --frozen python -m compileall app scripts` passed.
- `uv run --frozen ruff format --check app tests scripts migrations` passed.
- `uv run --frozen ruff check app tests scripts migrations` passed.
- `uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n` passed.
- `uv run --frozen pyright --project pyrightconfig.json` passed.
- `uv run --frozen pyright --project pyrightconfig.alpha.json` passed.
- `uv run --frozen pyright --project pyrightconfig.scripts.json` passed.
- `uv run --frozen pytest -q -x --tb=short` passed: `4926` tests before the final diff-coverage helper test was added.
- `uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml` passed after final changes:
  `4928` tests, total coverage `86.99%`.
- `uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90` passed:
  changed-line coverage `90.19%`.
- `git diff --check` passed.
- `bun run lint:argocd` passed.
- `.github/workflows/torghut-ci.yml` now runs the Pylint file-length check as a blocking CI gate and checks Ruff format.

## Design Gate Status

- The design-complexity scan is still non-blocking inventory.
- Current command:
  `uv run --frozen pylint app scripts --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n`
- Current result: `826` findings across `340` files.
- Finding mix: `461` `too-many-locals`, `139` `too-many-branches`, `122` `too-many-statements`, and `104`
  `too-many-return-statements`.
- Newly cleaned design slices:
  - `app/trading/autonomy/policy_check_modules/evidence_artifacts.py`
  - `app/trading/autonomy/policy_check_modules/evidence_core.py`
  - `app/trading/scheduler/paper_route_materialization.py`
  - `app/trading/discovery/fast_replay_modules/part_07_extract_price.py`
  - `app/trading/prices.py`
  - `app/trading/execution_modules/part_02_orderexecutormethodspart1.py`
  - `app/trading/scheduler/source_collection_modules/part_02_simplepipelinesourcecollectionmixinmethods.py`
  - `app/trading/scheduler/paper_route_probe_modules/part_03_simplepipelinepaperrouteprobemixinmethodsp.py`
  - `app/trading/decisions_modules/part_03_decisionenginemethodspart2.py`
  - `app/trading/decisions_modules/part_04_resolve_qty_for_aggregated.py`
  - `app/trading/completion_modules/part_02_runtime_ledger_bucket_existing_blockers.py`
  - `scripts/verify_trading_readiness_modules/part_02_paper_route_target_plan_summary.py`
  - `scripts/verify_trading_readiness_modules/part_02_target_plan_helpers.py`
  - `app/whitepapers/workflow_modules/part_06_whitepaperworkflowservicemethodspart4.py`
  - `app/api/readiness_helpers_modules/part_04_refresh_universe_state_for_readiness.py`
- Follow-up file-length repair after design-helper extraction:
  - `app/trading/prices.py` split private helpers into `app/trading/prices_helpers.py`.
  - `app/trading/execution_modules/part_02_orderexecutormethodspart1.py` split sell-inventory payload helpers.
  - `app/trading/scheduler/source_collection_modules/part_02_simplepipelinesourcecollectionmixinmethods.py`
    split module-level source-collection helpers.
  - `app/trading/scheduler/paper_route_materialization.py` split late materialization processing methods into a sibling mixin.
- Do not flip this gate to blocking until these are refactored by responsibility. Broad design-rule suppressions would
  defeat the purpose of this rollout.
- Blocking status: this command currently exits non-zero, so the final design gate remains blocked. The blocking CI
  flip in this branch must stay limited to file length unless the design backlog is refactored in a follow-up tranche.

### 2026-06-12 Design Gate Continuation Evidence

- `uv run --frozen pylint app/trading/completion_modules/part_02_runtime_ledger_bucket_existing_blockers.py --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n` passed.
- `uv run --frozen pytest tests/api/test_trading_api_status_metadata.py -q -k 'completion or doc29'` passed: `1` test.
- `uv run --frozen pytest tests/profitability_proof_floor -q` passed: `27` tests.
- `uv run --frozen pylint scripts/verify_trading_readiness_modules/part_02_paper_route_target_plan_summary.py scripts/verify_trading_readiness_modules/part_02_target_plan_helpers.py --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n` passed.
- `uv run --frozen pytest tests/verify_trading_readiness -q` passed: `46` tests.
- `uv run --frozen pylint app/whitepapers/workflow_modules/part_06_whitepaperworkflowservicemethodspart4.py --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n` passed.
- `uv run --frozen pytest tests/whitepaper_workflow -q` passed: `35` tests.
- `uv run --frozen pylint app/api/readiness_helpers_modules/part_04_refresh_universe_state_for_readiness.py --disable=all --enable=too-many-branches,too-many-locals,too-many-return-statements,too-many-statements --score=n` passed.
- `uv run --frozen pytest tests/api/test_trading_api_readyz_contract.py tests/api/test_trading_api_health_dependency.py -q` passed: `19` tests.
- `uv run --frozen pylint app scripts tests migrations --disable=all --enable=too-many-lines --score=n` passed after the helper extractions.

## PR Stack

1. `chore(torghut): add pylint file length guard`
2. `ci(torghut): surface pylint file length debt`
3. `test(torghut): lock main api compatibility`
4. `refactor(torghut): split app assembly from main`
5. `test(torghut): split trading api tests by endpoint`
6. `refactor(torghut): modularize whitepaper autoresearch runner`
7. `refactor(torghut): modularize runtime window import`
8. `refactor(torghut): modularize simulation frontier scripts`
9. `refactor(torghut): modularize trading runtime hotspots`
10. `refactor(torghut): finish oversized module split`
11. `ci(torghut): enforce pylint size gate`
12. Follow-up required: `refactor(torghut): reduce pylint design complexity debt`

## Commands

Inventory:

```bash
cd <repo-root>
rg --files services/torghut/app services/torghut/scripts services/torghut/tests services/torghut/migrations \
  | rg '\.py$' \
  | xargs wc -l \
  | sort -nr
```

Local static validation:

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

Local test validation:

```bash
cd services/torghut
uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml
uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90
```

Repo-level validation:

```bash
cd <repo-root>
git diff --check
bun run lint:argocd
```

## Hard Rules

- Do not use `# pylint: disable=too-many-lines`.
- Do not weaken existing Torghut proof, readiness, promotion, or runtime-ledger gates.
- Do not mix behavior fixes into extraction commits unless a failing regression test is added first.
- Do not report the work complete until Pylint passes for `app`, `scripts`, `tests`, and `migrations`.
- Do not remove `app.main` compatibility exports until the tests no longer patch those names.
