# Torghut Property-Based Testing, Coverage, and Lint Hardening (2026-03-28)

## Summary

Torghut should adopt **Hypothesis** as its primary property-based testing framework and move the service test runner to
**pytest + pytest-cov + coverage.py** while keeping **Ruff** and the three existing **Pyright** profiles as mandatory
quality gates.

The goal is not to add a second testing culture beside the current suite. The goal is to turn Torghut's most fragile,
stateful trading logic into a system that is:

- checked against invariants over large input spaces,
- checked against state-machine transitions for replay and execution flows,
- covered with enforced branch coverage thresholds,
- blocked from merging when changed high-risk code lacks test evidence.

This plan is intentionally **single-service** and Torghut-local. It integrates into `services/torghut/**`,
`.github/workflows/torghut-ci.yml`, and the current Torghut test layout. It does not require new microservices.

## Current state

As of `2026-03-28`, Torghut has:

- `110` `test_*.py` files under `services/torghut/tests`
- `109` of those files still using `unittest` / `TestCase`
- mandatory local and CI checks for:
  - `ruff check`
  - `pyrightconfig.json`
  - `pyrightconfig.alpha.json`
  - `pyrightconfig.scripts.json`
  - `python -m unittest discover -s tests -p "test_*.py"`
- no checked-in Hypothesis dependency
- no service-local pytest configuration
- no enforced line or branch coverage threshold
- no diff-coverage gate for changed files
- no mutation-testing safety net for high-risk trading modules

That means Torghut can pass CI while still having:

- narrow hand-authored example coverage,
- insufficient branch exploration in risk logic,
- replay/execution state regressions that only appear under odd sequences,
- weak guarantees that new code meaningfully increases tested behavior.

## Framework choice

### Primary framework: Hypothesis

Hypothesis is the right primary property-based framework for Torghut.

Reasons:

- It is the canonical Python property-based testing library.
- It works directly with both `pytest` and `unittest`.
- It supports custom strategies, composite strategies, and stateful testing.
- It is a strong fit for Torghut’s pure functions, typed payload transforms, and replay/runtime state machines.

The upstream docs explicitly position Hypothesis around writing tests that should hold **for all inputs in a described
range**, not just a few examples. The quickstart also notes that a Hypothesis test is still a normal Python function,
so `pytest` or `unittest` will collect it normally. The settings docs also make `max_examples` and profile-based
configuration first-class, which is important for separating fast PR checks from deeper nightly sweeps.

### Secondary complement: CrossHair

CrossHair is useful, but not as Torghut’s primary framework.

It should be used only for **targeted contract analysis** on small, pure, type-annotated helpers such as:

- quantity quantization,
- monotonic cap enforcement,
- ratio/rank normalization helpers,
- pure regime and feature coercion helpers.

Reasons it is secondary:

- it requires explicit contract entry points,
- it is best on deterministic, side-effect-free code,
- it is not a replacement for replay- and execution-oriented property testing,
- Torghut’s highest-risk surfaces are sequence- and state-based, where Hypothesis state machines are the better fit.

### Narrow optional add-on: Schemathesis

Schemathesis is appropriate only for Torghut’s HTTP contract surface.

It is valuable for:

- `GET /healthz`
- `GET /trading/status`
- `GET /trading/health`
- selected whitepaper workflow endpoints

It is not the core framework because Torghut’s largest correctness risk is not request/response fuzzing. It is
decision logic, replay correctness, sizing, and exit behavior.

### Mutation testing add-on: mutmut

`mutmut` should be added after the Hypothesis/coverage migration starts landing.

It is useful as a **quality amplifier**, not as the first migration step. For Torghut, the most important value is
targeted mutation runs on the deterministic trading core once those modules have better property coverage.

## Why this is the right Torghut strategy

Torghut’s bugs tend to be one of four types:

1. quantization and cap bugs in pure arithmetic helpers;
2. missing-field, contradictory-field, or zero-value bugs in payload normalization;
3. state-transition bugs in replay / fill / cancel / replace / flatten flows;
4. logic-gating bugs where one guard silently disables a strategy or wrongly emits an exit.

Example-based tests catch some of these, but they are weak against broad input surfaces and long state transitions.

Hypothesis gives Torghut the missing layer:

- randomized but reproducible coverage of edge cases,
- shrinking to minimal failing examples,
- state-machine exploration for replay and position flows,
- reusable strategy builders for the service’s typed financial payloads.

## Core integration design

### 1. Keep the current suite running, but switch the runner to pytest

Torghut should not do a flag-day rewrite from `unittest` to raw pytest functions.

Instead:

- keep existing `unittest.TestCase` files running under pytest,
- add new property tests as native pytest modules,
- migrate old tests opportunistically only when they are already being touched.

This is the safest path because pytest already supports running `unittest` suites while immediately unlocking:

- fixture composition,
- marker-based test selection,
- Hypothesis integration,
- better failure output,
- coverage tooling that fits modern Python CI.

### 2. Add a Torghut-local Hypothesis profile layer

Check in a Torghut profile module, for example:

- `services/torghut/tests/hypothesis_profiles.py`

Profiles should be explicit and environment-aware:

- `ci_fast`
  - smaller `max_examples`
  - no global deadline disable
  - used for PR CI
- `ci_stateful`
  - moderate example counts for rule-based state machines
  - stricter health-check handling
- `nightly_deep`
  - higher `max_examples`
  - extended state-machine steps
  - used by scheduled CI only
- `local_debug`
  - verbose output
  - easier reproduction and replay

The service should load profiles through pytest startup rather than ad hoc per-file settings, while still allowing
file-local overrides where justified.

### 3. Introduce shared Torghut data strategies

Add a central strategy module, for example:

- `services/torghut/tests/strategies/trading.py`
- `services/torghut/tests/strategies/signals.py`
- `services/torghut/tests/strategies/replay.py`

These should generate:

- symbols from the Jangar/Torghut equity universe shape
- valid and invalid quote payloads
- realistic `Decimal` prices, spreads, notionals, qty values
- feature payloads with controlled missing/contradictory fields
- signal envelopes with chronological and out-of-order timestamps
- account / position / pending-order states

The rule is:

- do not let every test file invent its own random payloads
- centralize generators so Torghut’s test semantics stay coherent

### 4. Use stateful testing where Torghut is truly stateful

Rule-based state machines should be introduced for:

- replay pending-order management,
- same-tick immediate fill behavior,
- replace/cancel/flatten interactions,
- session-context day rollover,
- strategy-local cooldown and max-entry tracking,
- allocator exposure accounting across multiple decisions.

This is where Hypothesis materially improves Torghut over example-based tests.

## High-priority target modules and required invariants

### A. Quantity and execution constraints

Primary files:

- `services/torghut/app/trading/quantity_rules.py`
- `services/torghut/app/trading/portfolio.py`

Required property tests:

- quantization is idempotent:
  - quantizing an already quantized qty must return the same qty
- valid increment equivalence:
  - `qty_has_valid_increment(...)` must agree with quantization equality
- min qty consistency:
  - `min_qty_for_symbol(...)` must equal the chosen `qty_step`
- sell reduction monotonicity:
  - reducing-long sells may preserve fractional behavior
  - short-increasing sells must never silently become fractional
- cap monotonicity:
  - tighter symbol/gross/strategy caps must never increase approved qty or notional
- approved size soundness:
  - approved qty must never exceed requested economic intent after quantization and caps

### B. Quote and feature normalization

Primary files:

- `services/torghut/app/trading/features.py`
- `services/torghut/app/trading/quote_quality.py`
- `services/torghut/app/trading/session_context.py`

Required property tests:

- executable price soundness:
  - crossed or non-positive quotes must not yield a valid executable state
- top-level value precedence:
  - explicit zero-valued top-level market fields must not silently fall back to nested fields
- ratio/rank bounds:
  - ranks and positive-ratio features must stay in `[0, 1]`
- midpoint/microprice coherence:
  - valid bid/ask inputs must yield deterministic midpoint and bounded microprice bias behavior
- session range coherence:
  - `session_high >= session_low`
  - `opening_range_high >= opening_range_low`
  - price position in range must remain in `[0, 1]` when range is non-zero
- new-day reset correctness:
  - premarket ticks must not establish the regular-session open anchor

### C. Strategy runtime and decision engine behavior

Primary files:

- `services/torghut/app/trading/strategy_runtime.py`
- `services/torghut/app/trading/research_sleeves.py`
- `services/torghut/app/trading/decisions.py`

Required property tests:

- missing required features must fail closed
- isolated strategies must not exit inventory they do not own
- exit-only sleeves must never generate new net-long exposure through sell paths
- cooldown enforcement must be monotonic across repeated same-strategy inputs
- changing one guard should not cause contradictory buy and sell outputs for the same isolated owner in one evaluation
- profitable exit floors must never approve a sell at a non-executable or loss-inducing limit when the policy forbids it
- max-hold and session-flatten overlays must dominate normal hold logic when their trigger conditions are met

### D. Replay correctness

Primary file:

- `services/torghut/scripts/local_intraday_tsmom_replay.py`

Required property tests:

- no stale pending order may survive an immediate fill for the same `(symbol, position_owner)`
- a pending sell may not over-close beyond the owned long quantity
- a pending buy must reserve projected exposure for subsequent sizing decisions
- non-executable quotes must not advance last-valid executable price
- replacing an order with a more urgent exit must remove the stale resting order
- same input stream must produce deterministic replay output

This file is the best candidate for a `RuleBasedStateMachine`.

### E. Scheduler pipeline and execution routing

Primary files:

- `services/torghut/app/trading/scheduler/pipeline.py`
- `services/torghut/app/trading/scheduler/simple_pipeline.py`
- `services/torghut/app/trading/execution_adapters.py`

Required property tests:

- backfilled price/spread enrichment must not fabricate a valid decision from contradictory quote state
- simulation and non-simulation routing must preserve their execution policy invariants
- a valid price-fetch backfill must not be dropped by later quote gating when the backfilled state is executable
- adapter payload validation must reject structurally inconsistent order payloads rather than coerce them silently

## Stateful testing plan

### Replay state machine

Create a `RuleBasedStateMachine` around replay order flow with rules such as:

- create buy intent
- create sell intent
- immediate-fill order
- rest passive limit
- replace with more aggressive exit
- cancel pending order
- flatten position
- ingest invalid quote
- ingest executable quote

Invariants:

- net position per `(symbol, position_owner)` never becomes impossible under the applied fills
- pending order book contains at most one active logical order per `(symbol, position_owner, side)` where policy says replacement semantics should apply
- realized P&L only changes on executed fills
- fill counts and cost counts only change on actual fills

### Session-context state machine

Rules:

- ingest premarket tick
- ingest regular-session tick
- advance time within opening window
- advance beyond opening window
- roll to next trading day

Invariants:

- opening anchor is never set by premarket data
- previous close is carried only across session boundaries
- session highs and lows remain monotonic within a day
- quote-quality windows never exceed configured max length

### Strategy/cooldown state machine

Rules:

- emit buy from strategy A
- emit buy from strategy B
- attempt same-direction reentry
- trigger stop loss
- trigger max hold
- trigger session flatten

Invariants:

- isolated owner cooldowns remain strategy-scoped
- stop-loss lockout is honored once triggered
- exit-only rules cannot create inventory
- `max_concurrent_positions` cannot be exceeded by accepted entries

## Coverage strategy

### Coverage toolchain

Use:

- `pytest`
- `coverage.py`
- `pytest-cov`

Coverage must be **branch coverage**, not statement-only coverage.

The minimum checked-in configuration should live in `services/torghut/pyproject.toml` under:

- `[tool.pytest.ini_options]`
- `[tool.coverage.run]`
- `[tool.coverage.report]`
- `[tool.coverage.html]`

### Coverage policy

Phase 1 thresholds:

- service-wide branch coverage fail-under: `70`
- changed-files coverage fail-under: `90`
- no uncovered lines in newly added property-test target modules unless explicitly excluded

Phase 2 thresholds:

- service-wide branch coverage fail-under: `78`
- changed-files coverage fail-under: `92`

Phase 3 thresholds:

- service-wide branch coverage fail-under: `85`
- changed-files coverage fail-under: `95`

Coverage exclusions must be minimal:

- `# pragma: no cover` only for true unreachable/defensive branches
- `# pragma: no branch` only when branch coverage would otherwise report structurally impossible control flow

### Why changed-files coverage matters

Torghut is too large to demand an immediate full-suite `90%+` branch number without causing fake exclusions.

The correct rollout is:

- ratchet overall coverage gradually,
- enforce very high coverage on touched files now,
- require property tests for touched files in the trading core.

## Lint and static-analysis hardening

### Mandatory blockers

Keep these mandatory:

- `ruff check app tests scripts migrations`
- `pyright --project pyrightconfig.json`
- `pyright --project pyrightconfig.alpha.json`
- `pyright --project pyrightconfig.scripts.json`

Add these mandatory:

- `pytest` on the Torghut suite
- branch coverage fail-under
- changed-files coverage gate

### Ruff tightening plan

Current Torghut already uses Ruff, but the service should make the following explicit in checked-in config:

- complexity and security scans should graduate from non-blocking signal to enforced gate for touched files
- import-order, unused-code, and assertion-style rules should stay enforced
- production exceptions should be documented inline, not silently ignored globally

Recommended rule posture:

- keep `C901` as a reported metric immediately
- require complexity cleanup for new or heavily modified trading modules
- fail CI when touched files add new `C901` violations
- make `S` security rules blocking for new violations in `app/` and `scripts/`

### Dead-code and stale-path control

Torghut already has Vulture configuration. Keep it as part of the quality stack:

- Vulture remains the `100%`-confidence dead-code pass
- Hypothesis + coverage become the semantic regression pass
- Ruff + Pyright remain the syntactic and typed discipline pass

These are complementary, not overlapping.

## CI design

### Replace the current unit-test command

Current:

```bash
uv run --frozen python -m unittest discover -s tests -p "test_*.py"
```

Target:

```bash
uv run --frozen pytest
```

This should happen early because pytest can already run the existing `unittest` suite.

### Proposed CI stages

#### Stage 1: Type and lint

- `uv sync --frozen --extra dev`
- `ruff check app tests scripts migrations`
- all three Pyright profiles

#### Stage 2: Core tests with coverage

- `uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-fail-under=<threshold>`

#### Stage 3: Property-focused shard

- run a marked subset such as:
  - `-m property`
  - `-m stateful`
- use the Torghut `ci_fast` or `ci_stateful` Hypothesis profile

#### Stage 4: Optional nightly deep quality

- Hypothesis deep profile
- state-machine suites with larger budgets
- mutmut on a curated module set
- optional CrossHair checks on targeted pure helpers
- optional Schemathesis on public Torghut endpoints

## File-level implementation plan

### Phase 0: Harness and non-breaking migration

Files:

- `services/torghut/pyproject.toml`
- `.github/workflows/torghut-ci.yml`
- `services/torghut/README.md`
- `services/torghut/tests/conftest.py`
- `services/torghut/tests/hypothesis_profiles.py`

Changes:

- add `pytest`, `hypothesis`, `pytest-cov`, and `coverage[toml]` to dev dependencies
- move test execution to pytest
- add pytest markers:
  - `property`
  - `stateful`
  - `slow`
  - `mutation`
- add coverage configuration and initial thresholds

### Phase 1: Pure-function property layer

Files:

- `services/torghut/app/trading/quantity_rules.py`
- `services/torghut/app/trading/features.py`
- `services/torghut/app/trading/quote_quality.py`
- `services/torghut/app/trading/session_context.py`
- `services/torghut/tests/property/test_quantity_rules_properties.py`
- `services/torghut/tests/property/test_feature_contract_properties.py`
- `services/torghut/tests/property/test_quote_quality_properties.py`
- `services/torghut/tests/property/test_session_context_properties.py`

### Phase 2: Stateful runtime and replay layer

Files:

- `services/torghut/scripts/local_intraday_tsmom_replay.py`
- `services/torghut/app/trading/decisions.py`
- `services/torghut/app/trading/strategy_runtime.py`
- `services/torghut/app/trading/portfolio.py`
- `services/torghut/tests/stateful/test_replay_state_machine.py`
- `services/torghut/tests/stateful/test_strategy_runtime_state_machine.py`
- `services/torghut/tests/property/test_portfolio_allocator_properties.py`

### Phase 3: Scheduler and API hardening

Files:

- `services/torghut/app/trading/scheduler/pipeline.py`
- `services/torghut/app/trading/execution_adapters.py`
- `services/torghut/tests/property/test_pipeline_properties.py`
- `services/torghut/tests/api/test_trading_status_schemathesis.py`

### Phase 4: Mutation testing on curated targets

Files/config:

- `services/torghut/pyproject.toml`
- optional `services/torghut/mutmut_pytest.ini`

Initial mutation target set:

- `app/trading/quantity_rules.py`
- `app/trading/quote_quality.py`
- `app/trading/features.py`
- `app/trading/session_context.py`

Do not start mutation testing on:

- broad scheduler end-to-end paths,
- whitepaper workflows,
- large DB-heavy integration areas.

Start where determinism is strongest.

## Strict rules Torghut should adopt

1. Every change to `app/trading/**` must add or touch tests unless the change is comment-only or pure dead-code removal.
2. Every change to these files must include at least one property-based test:
   - `quantity_rules.py`
   - `features.py`
   - `quote_quality.py`
   - `session_context.py`
   - `portfolio.py`
   - `decisions.py`
   - `strategy_runtime.py`
   - `local_intraday_tsmom_replay.py`
3. New branches in high-risk trading code must not be merged under coverage unless they are justified with explicit `pragma` usage.
4. New global Ruff ignores should be treated as design regressions and require justification in the PR.
5. New Pyright suppressions in trading-core files should be treated as design regressions and require justification in the PR.
6. Property tests must use centralized Torghut strategies, not ad hoc random payload generation.
7. Stateful tests must assert invariants after every rule, not only at final teardown.
8. Mutation testing is required for curated high-risk pure modules before calling the property-testing rollout complete.

## Acceptance criteria

The migration is successful when all of the following are true:

- Torghut CI uses `pytest` instead of `unittest discover`
- Hypothesis is a checked-in dev dependency
- property-test directories exist and are populated for trading-core modules
- at least one `RuleBasedStateMachine` suite protects replay behavior
- branch coverage is enforced in CI
- changed-files coverage is enforced in CI
- Ruff and all three Pyright profiles remain green
- mutmut is documented and runs on the curated pure-module slice
- touching high-risk trading files without test evidence is no longer possible in normal CI

## Recommended commands

Local fast path:

```bash
cd services/torghut
uv sync --frozen --extra dev
uv run --frozen pytest -m "not slow" --cov --cov-branch --cov-report=term-missing
```

Property-only:

```bash
cd services/torghut
uv run --frozen pytest -m property
```

Stateful-only:

```bash
cd services/torghut
uv run --frozen pytest -m stateful
```

Targeted CrossHair pass on pure helpers:

```bash
cd services/torghut
uvx --from crosshair-tool crosshair check --analysis_kind=asserts app/trading/quantity_rules.py
```

Targeted mutation pass:

```bash
cd services/torghut
uvx --from mutmut mutmut run app.trading.quantity_rules*
```

## Decision

Torghut should standardize on:

- **Hypothesis** for property-based and stateful testing
- **pytest** as the unified test runner
- **coverage.py + pytest-cov** for branch and diff coverage enforcement
- **Ruff + Pyright** as non-negotiable static gates
- **mutmut** as the follow-on mutation-quality amplifier
- **CrossHair** only for selective pure-function contract analysis
- **Schemathesis** only for selective HTTP contract fuzzing

That is the highest-leverage, lowest-bullshit path to materially stronger Torghut quality.
