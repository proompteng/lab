# Workflow Runtime Sandbox Guards (Design)

This document specifies runtime “sandbox guard” behavior for
`@proompteng/temporal-bun-sdk` workflows.

The Bun SDK runs workflow code in-process (not in a V8 isolate). That improves
DX and deployment simplicity, but removes the default safety nets present in
Temporal’s Node SDK (VM + bundler restrictions).

We add lightweight, production-safe runtime wrappers that:

1. Make common nondeterministic primitives deterministic when used in workflow
   context.
2. Fail fast on side effects that cannot be made deterministic.

These wrappers are context-aware, based on AsyncLocalStorage:
they only activate while workflow code is executing.

## Design Constraints

- Must not change behavior for activities, worker runtime, CLI tools, or user
  services running in the same process.
- Must be safe under concurrency (multiple workflows in the same worker).
- Must not rely on per-workflow global mutation (we cannot swap `Date` per
  workflow).
- Must support “query mode” execution where commands/time/random advances are
  disallowed.
- Must be cheap: wrappers should be O(1) per call and avoid allocations.

## Workflow Execution Context

We define “workflow context” as:

- Code executed while `WorkflowExecutor.execute` is evaluating a workflow
  definition handler and update handlers.
- Code executed while evaluating workflow queries (query mode).

We can detect that state via AsyncLocalStorage.

### Context Source Of Truth

We already maintain an ALS in `packages/temporal-bun-sdk/src/workflow/log.ts`
(`WorkflowLogContext`) containing:

- `info: WorkflowInfo`
- `guard: DeterminismGuard`
- `logger: WorkflowLogger`

This is sufficient for guards, but we may want to add:

- `mode: 'workflow' | 'query'`

Implementation option:

- Extend `WorkflowLogContext` to include `mode`, set in
  `packages/temporal-bun-sdk/src/workflow/executor.ts` based on `ExecuteWorkflowInput.mode`.

The wrappers use:

```ts
import { currentWorkflowLogContext } from './log'
const ctx = currentWorkflowLogContext()
```

If `ctx` is undefined, we are not in workflow context.

## Guard Modes

Controlled by `TEMPORAL_WORKFLOW_GUARDS` / `WorkerRuntimeOptions.workflowGuards`:

- `strict`: throw on forbidden APIs
- `warn`: log a structured warning and proceed
- `off`: do nothing

Runtime wrappers should be installed once per process, and behave according to
the configured mode.

## Deterministic Wrappers

### `Date.now()`

In workflow context:

- `Date.now()` must route through `DeterminismGuard.nextTime`.
- The underlying “real” time source should be the original `Date.now` captured
  at install time.

Pseudo-code:

```ts
const original = Date.now.bind(Date)
Date.now = () => {
  const ctx = currentWorkflowLogContext()
  if (!ctx) return original()
  return ctx.guard.nextTime(original)
}
```

### `Math.random()`

In workflow context:

- Must route through `DeterminismGuard.nextRandom`.

Pseudo-code:

```ts
const original = Math.random.bind(Math)
Math.random = () => {
  const ctx = currentWorkflowLogContext()
  if (!ctx) return original()
  return ctx.guard.nextRandom(original)
}
```

### `performance.now()` and `Bun.nanoseconds()`

These are high resolution and nondeterministic. Options:

1. In strict mode, throw.
2. In warn mode, log.
3. Provide a deterministic value derived from `Date.now()` (lower resolution).

Recommendation:

- `performance.now()` returns a deterministic “monotonic” value derived from
  `guard.nextTime(() => Date.now())` with a per-workflow base.
- `Bun.nanoseconds()` is forbidden in workflow context (no stable semantics).

If we implement deterministic `performance.now()`, it must be documented as:
“workflow time, not wall clock monotonic time”.

### `crypto.randomUUID()` and `crypto.getRandomValues()`

These must not be used directly in workflow context.

Strict mode behavior:

- Throw with remediation:
  - use `ctx.determinism.sideEffect({ compute: () => crypto.randomUUID() })`
  - or derive IDs from workflow info and deterministic counters.

Warn mode behavior:

- Log and proceed.

Rationale: UUIDs can be made deterministic via side effect markers, but a direct
call without `sideEffect` is a common footgun.

## Forbidden APIs (Fail Fast In Strict)

These cannot be made deterministic and must be blocked in workflow context.

### Network / I/O

- `fetch`
- `WebSocket`
- filesystem access (`Bun.file`, `fs`, `node:fs`, etc.)
- `Deno.*` style I/O if present

Error message must include:

- the API used
- the workflow identity (`workflowType`, `workflowId`, `runId`)
- the safe alternative:
  - move the operation into an activity
  - or use signals/updates to fetch data externally

### Timers

- `setTimeout`, `setInterval`, `queueMicrotask`, `setImmediate`

In strict mode, these throw in workflow context and point to:

- `ctx.timers.start` for workflow timers
- `Effect` composition for sequencing

Rationale: JS timers are scheduled by the host runtime and are not tied to
workflow history. Workflow sleeps must materialize as timer commands.

### Subprocesses / System

- `Bun.spawn`, `child_process`, `Deno.run`
- `process.exit`
- `process.kill`

### Environment and Host Introspection

Reading environment variables at runtime is a common replay hazard. Runtime
wrapping cannot reliably intercept arbitrary property reads (like `process.env.X`),
so enforcement is primarily via lint. In strict runtime mode we still block
common accessors:

- `Bun.env` (if used)
- `process.cwd`, `process.uptime`, `os.*` calls if they are reachable as globals

## Logging

Workflow log output is a side effect, but does not affect replay unless the
workflow branches on it. We already track log count in `DeterminismGuard` when
logs are emitted via the SDK logger (`packages/temporal-bun-sdk/src/workflow/log.ts`).

We should:

- Patch `console.*` methods to route through workflow logging when in workflow
  context, so log volume is tracked consistently.
- In query mode, logs should be suppressed (or tagged) to match existing
  `recordLog` behavior.

## Implementation Sketch

### Module layout

- New module: `packages/temporal-bun-sdk/src/workflow/guards.ts`
  - `installWorkflowRuntimeGuards(options)`
  - wrappers for each global API
  - idempotent install
  - relies on `currentWorkflowLogContext()`

### Install timing

Install guards on first workflow execution and keep them installed for the
process lifetime.

- Install entrypoint: `packages/temporal-bun-sdk/src/workflow/executor.ts`
  - call `installWorkflowRuntimeGuards(...)` at the beginning of `execute()`
  - ensure install is idempotent (static boolean)

### Strictness resolution

Strictness comes from:

1. `WorkerRuntimeOptions.workflowGuards` if set
2. `TEMPORAL_WORKFLOW_GUARDS` env var
3. default based on `NODE_ENV`-style heuristics is not reliable under Bun

Recommendation: default to `warn`, and services flip to `strict` intentionally.

### Wrapper behavior: `warn` vs `strict`

All forbidden wrappers call the same helper:

```ts
function violation(api: string, message: string): never | undefined
```

- In `warn`, log a structured event and return `undefined` or defer to original.
- In `strict`, throw `WorkflowNondeterminismError` with a remediation hint.

### Error types

Use existing workflow error classes:

- `WorkflowNondeterminismError` for workflow mode
- `WorkflowQueryViolationError` for query mode

## Test Plan

Add unit tests under `packages/temporal-bun-sdk/tests/`:

1. `Date.now` is deterministic in workflow context.
2. `Math.random` is deterministic in workflow context.
3. `fetch` throws in strict mode when called from workflow handler.
4. `setTimeout` throws in strict mode when called from workflow handler.
5. `console.log` in workflow context increments `logCount` (if console patching is implemented).

## Failure Modes

- If ALS context is lost across Effect boundaries, wrappers may incorrectly fall
  back to nondeterministic behavior. This must be validated with tests that
  cross async boundaries inside workflows.
- If a forbidden wrapper is bypassed by importing a module-local binding
  (captured reference), linting must catch it. Example:
  `const realFetch = fetch;` then calling `realFetch` later.
  Mitigation: lint rules for capturing forbidden globals.

