# Nondeterminism Guardrails (Production Design)

This document defines a defense-in-depth plan for making nondeterministic Workflow
Task failures effectively impossible in production for workflows authored against
`@proompteng/temporal-bun-sdk`.

Temporal’s core guarantee is durability via replay. If workflow code changes in a
way that would emit different commands for the same history, the server will fail
workflow tasks with `WORKFLOW_TASK_FAILED_CAUSE_NON_DETERMINISTIC_ERROR`.

We cannot make nondeterminism “impossible” for arbitrary TypeScript. We can make
it operationally impossible to hit in production by enforcing these invariants:

1. Old runs never execute new workflow code (worker build ID versioning, pinned).
2. Workflow code cannot accidentally depend on nondeterministic sources (runtime
   guards and build-time linting).
3. Releases are blocked if they break replay on known histories (replay CI gate).

## Problem Statement

Teams regularly hit nondeterminism in production because:

- A workflow is edited without adding a versioning branch.
- A transitive dependency uses nondeterministic APIs (time, randomness, I/O).
- A workflow mistakenly performs I/O directly in workflow context.
- CI does not replay histories from older versions.

The failure mode is expensive: stuck or failing workflow tasks and operational
recovery work (resets, patches, or emergency worker pinning).

## Goals

- Prevent production nondeterminism by default, without relying on every engineer
  to remember Temporal’s replay rules.
- When a workflow change requires a version branch, surface that requirement at
  PR time (lint and replay gate), not after deploy.
- Provide deterministic shims for common APIs (time, randomness) so “doing the
  obvious thing” stays safe.
- Provide failure messages and diagnostics that are actionable and point to the
  correct remediation.

## Non-Goals

- Implementing a full isolate-based workflow sandbox.
- Preventing nondeterminism in intentionally bypassed code paths.
- Eliminating nondeterminism errors caused by cross-version histories when worker
  versioning is explicitly disabled.

## Existing Mechanisms In The Repo

- Determinism ledger and mismatch detection: `packages/temporal-bun-sdk/src/workflow/determinism.ts`
- History replay reconstruction and diffing: `packages/temporal-bun-sdk/src/workflow/replay.ts`
- Worker-side nondeterminism enrichment and retry: `packages/temporal-bun-sdk/src/worker/runtime.ts`
- Worker build ID compatibility registration: `packages/temporal-bun-sdk/src/worker/build-id.ts`
- Workflow versioning helpers surfaced to users:
  `packages/temporal-bun-sdk/src/workflow/context.ts` (`determinism.getVersion`, `determinism.patched`, `determinism.sideEffect`)

## Proposal Overview

We introduce four guardrail layers plus improved diagnostics.

### Layer A: Production Worker Versioning Policy (Mandatory)

In production, all workers that can run workflows must be versioned and pinned:

- `WorkerVersioningMode.VERSIONED`
- `VersioningBehavior.PINNED`
- `buildId` is a stable, deploy-derived identifier (git sha, semver, etc.)

In strict mode, the worker fails fast if:

- Worker versioning APIs are unsupported by the server.
- Build ID registration is skipped.
- Build ID is missing or looks accidental (e.g. equals identity).

Rationale: this makes it operationally impossible for old workflow runs to ever
load new workflow code, which is the single most important guardrail.

See `worker-ops-and-versioning.md` for the existing user-facing API surface.

### Layer B: Runtime Workflow Guards (Default On In Production)

At runtime, the SDK installs process-wide wrappers for key globals that check:
“are we executing in workflow context right now?” using AsyncLocalStorage.

If not in workflow context, behavior is unchanged.

If in workflow context:

- Time and randomness are made deterministic by routing through the determinism
  guard.
- Side-effectful APIs (I/O, timers, subprocess) throw immediately with a message
  describing the safe alternative (activities, timers, `determinism.sideEffect`).

This prevents accidental nondeterminism from:

- `Date.now()`, `Math.random()`, `performance.now()`
- `fetch()`, `WebSocket`, filesystem access
- `setTimeout`/`setInterval` in workflow context (workflows must use workflow
  timer commands instead)

See `workflow-runtime-sandbox.md`.

### Layer C: Build-Time Workflow Lint (Default On In CI)

Add a workflow lint command that runs on workflow sources before merging:

- Detect disallowed imports for workflow code.
- Detect direct usage of banned globals and patterns.
- Enforce that workflow entrypoints are labeled and analyzable.

See `workflow-linting.md`.

### Layer D: Replay CI Gate (Golden Histories)

Any change to workflow code must pass deterministic replay against a curated set
of histories (fixtures plus optionally staging/prod exports).

The gate is “red” unless:

- Replay is deterministic, or
- The workflow change is explicitly guarded (`getVersion` / `patched`) and the
  new code path is pinned to a new build ID.

See `replay-ci-gate.md`.

### Diagnostics Improvements

When a mismatch still occurs (SDK bug, misconfiguration, or explicit opt-out),
errors must become actionable:

- `WorkflowNondeterminismError.details` should include:
  - the first mismatch index (command/time/random)
  - a stable signature of the expected vs received intent
  - the last applied determinism marker (event ID, marker version)
  - remediation hints:
    - enable build ID versioning
    - add `determinism.getVersion` / `determinism.patched`
    - move I/O into activities

## Configuration

Add a strictness knob in config and as runtime options.

### Env Vars

- `TEMPORAL_WORKFLOW_GUARDS=strict|warn|off`
  - `strict`: block side effects + enforce versioning policy at startup
  - `warn`: log violations but do not throw (safe for gradual rollout)
  - `off`: no runtime wrappers (not recommended)
  - default: `strict` when `NODE_ENV=production`, otherwise `warn` (no env var required)
- `TEMPORAL_WORKFLOW_LINT=strict|warn|off` (controls CLI lint default behavior)
- `TEMPORAL_REPLAY_GATE_REQUIRED=1` (CI convenience toggle; defaults to enabled
  for repos that declare workflows)

### Programmatic Options

Extend `WorkerRuntimeOptions`:

```ts
type WorkerRuntimeOptions = {
  workflowGuards?: 'strict' | 'warn' | 'off'
  workflowLint?: 'strict' | 'warn' | 'off'
  // existing fields...
}
```

## Rollout Plan

1. Introduce runtime guards in `warn` mode by default. Validate on one service.
2. Introduce lint in `warn` mode in CI. Track violations, fix workflows.
3. Enable build ID versioning and PINNED behavior in production environments.
4. Flip runtime guards to `strict` in production.
5. Flip lint to `strict` for workflow packages.
6. Add replay gate with a small golden set, then expand over time.

## Backwards Compatibility

- Local development against `temporal server start-dev` often lacks versioning
  APIs. In strict mode we must allow an explicit opt-out for local dev.
- Runtime wrappers must be implemented as “context aware” wrappers that are
  no-ops outside workflow execution.
- Lint must allow escape hatches with explicit annotations for rare legitimate
  cases, but must require an allowlist comment and an issue reference.

## Implementation Notes (For Agent Runs)

This section is deliberately concrete so an agent run can implement without
re-planning.

1. Add workflow execution context ALS distinct from logging context, or reuse
   the existing `WorkflowLogContext`:
   - `packages/temporal-bun-sdk/src/workflow/log.ts`
2. Add guard installer and wrappers:
   - new module: `packages/temporal-bun-sdk/src/workflow/guards.ts`
   - wire into `packages/temporal-bun-sdk/src/workflow/executor.ts` so it installs
     once per process and is active during execution.
   - add `// TODO(TBS-NDG-001): ...` markers for each wrapper.
3. Update worker startup policy:
   - `packages/temporal-bun-sdk/src/worker/runtime.ts`
   - if `workflowGuards === 'strict'`, require versioning APIs to be supported
     and build ID registration to succeed when `deployment.versioningMode === VERSIONED`.
   - add `// TODO(TBS-NDG-002): enforce strict versioning policy`.
4. Add CLI lint command:
   - new: `packages/temporal-bun-sdk/src/bin/lint-workflows-command.ts`
   - update CLI router: `packages/temporal-bun-sdk/src/bin/temporal-bun.ts`
   - add `// TODO(TBS-NDG-003): lint-workflows` markers.
5. Add replay gate documentation and a sample CI workflow snippet:
   - `docs/temporal-bun-sdk/replay-ci-gate.md`
6. Add tests:
   - new tests under `packages/temporal-bun-sdk/tests/` covering wrappers.

## Acceptance Criteria

1. With `workflowGuards=strict`, calling `Date.now()` or `Math.random()` in a
   workflow produces deterministic values tied to the determinism ledger.
2. With `workflowGuards=strict`, calling `fetch()` in workflow context fails with
   an error message that suggests moving the call to an activity.
3. With `workflowGuards=strict`, using `setTimeout` in workflow context fails and
   points to workflow timers.
4. With build ID versioning enabled and pinned, deploying a new build cannot
   cause nondeterminism for existing runs on the same task queue.
5. `temporal-bun lint-workflows` detects banned imports and banned APIs.
6. Replay gate blocks a change that removes a previously-emitted command unless
   a version branch is added.
