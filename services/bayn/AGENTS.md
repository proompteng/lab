# Bayn Service Guide

## Service contract

- Bayn is a fail-closed quantitative evaluation service. Keep strategy and accounting evidence separate from broker or
  capital authority; a `PASS`, healthy pod, or reconciled ledger never grants either.
- Signal ClickHouse is read-only at runtime. Do not add DDL, backfill, administrative credentials, or dataset ownership
  to the deployed service.
- Keep strategy math, deterministic identifiers, manifests, and reconciliation plans as pure TypeScript. Given the same
  code revision, protocol, and data, they must produce the same result.

## Effect baseline

- `package.json` is authoritative for the Effect version. Bayn uses the exact Effect 4 beta cohort; keep `effect` and
  `@effect/platform-node` on the same version. Verify APIs against installed sources and `~/github.com/effect` only when
  its package versions match. APIs under `effect/unstable/**` may change between betas, so never use floating ranges.
- Use Effect at I/O and application boundaries, not as a wrapper around pure functions or constants.
- Prefer official Effect integrations when they remove hand-written lifecycle, interruption, or decoding code. Add them
  as direct, peer-compatible dependencies; never rely on another workspace's transitive dependency.

## Runtime and composition

- Use `NodeRuntime.runMain` at the entry point. Do not build a second runtime with `runPromise(...).catch(...)`, manual
  exit codes, or process signal handlers. Let interruption unwind scopes and finalizers.
- Define a `Context.Service` only for a real replaceable capability. Build live implementations with `Layer`; assemble
  them once at the composition root. Do not create services for pure helpers or single-use values.
- Own every long-lived client, server, or background fiber with a scoped `Layer`, `Effect.acquireRelease`, or
  `Effect.forkScoped`. Acquisition, interruption, and release must have tests. Never detach a Promise or fiber.
- Use `Effect.gen` for readable orchestration. Use `Effect.fn` for a meaningful traced operation and `Effect.fnUntraced`
  only for a reusable or measured hot helper; do not mechanically wrap one-line effects.

## Failures, cancellation, and time

- Expected operational failures use the typed error channel and domain `Data.TaggedError` values that retain the cause.
  Defects are reserved for violated invariants and programming bugs. Do not erase causes into generic strings.
- Never use JavaScript `try/catch` to handle a yielded Effect. Use `Effect.try` for throwing synchronous APIs,
  `Effect.tryPromise` for rejecting Promise APIs, and `catchTag`, `mapError`, or `tapErrorCause` for recovery/reporting.
- A Promise adapter must forward Effect's `AbortSignal` when supported. Otherwise supply an explicit cancellation action
  that actually stops the operation. A timeout without cancellation is not complete.
- Use `Clock`, `Duration`, `Schedule`, and `TestClock` instead of ambient time and hand-written timers. Retries must be
  bounded and must not turn an unknown outcome into a duplicate accounting or trading mutation.

## Configuration, data, and observability

- Read environment values through `Config` and test with `ConfigProvider`; do not read `process.env` in domain or
  service modules. Validate once at startup and keep secrets `Redacted` until the third-party client boundary.
- Decode every external payload with `Schema` or `SqlSchema`. A TypeScript assertion such as `json<Row>()` is not
  runtime validation. Pure domain code accepts decoded values only.
- Model closed external vocabularies with TypeScript enums and `Schema.Enum`; do not repeat magic strings. Namespace
  and version durable wire-contract identifiers, but keep internal names domain-oriented.
- Do not use non-null assertions in production code. Narrow or validate the value and fail with a useful invariant.
- Use `Effect.log*`, `Effect.annotateLogs`, and log spans. Production logs use `Logger.consoleJson`. Do not call `console.*`
  inside an Effect; direct console output is only an emergency before the runtime exists. Never log credentials.
- Effect 4 HTTP lives under `effect/unstable/http`; use it with `@effect/platform-node` instead of hand-written Node
  request, signal, or shutdown plumbing. For ClickHouse, prefer `@effect/sql-clickhouse` when its exact Effect cohort is
  compatible. Keep SQL explicit and parameterized; Effect SQL replaces plumbing, not SQL. Use a thin scoped adapter
  only when no official integration exists, as with TigerBeetle.

## Trading and accounting invariants

- Market-data snapshots must prove dataset version, universe, uniqueness, ordering, and content identity before
  evaluation. Missing, stale, malformed, or mixed-contract data fails closed.
- Inspect finalized manifest and calendar before candidate bars, then acquire the immutable qualification lock. Commit
  the evaluation graph and terminal result together; never retry or bypass an opened-incomplete lock.
- TigerBeetle writes remain deterministic and idempotent. Existing IDs must be verified against the complete expected
  record, and readiness requires exact account, transfer, and balance reconciliation.
- Select one `Strategy` capability at the composition root; the strategy owns its protocol and universe. Do not add a
  runtime registry, scheduler, event bus, repository layer, or generic retry framework without a current requirement.
- Define strategies and protocols in TypeScript. Do not add JSON strategy files, legacy loaders, or fallback paths;
  make contract changes explicit and migrate callers directly.

## Tests and validation

- Keep pure tests synchronous. Run Effects only at the outer test boundary with `Effect.runPromise` or
  `Effect.runPromiseExit`; test layers replace external systems. Unit tests never require the live cluster.
- Cover success, typed failure, defect propagation, interruption, timeout cancellation, and exactly-once finalization
  for changed Effectful code. Use deterministic fixtures and `TestClock` for time-dependent behavior.
- Test observable behavior and durable contracts. Do not add tests that scan source text, filenames, or the absence of
  old implementation details.
- Run the focused test first, then before completing a code change run:

```sh
bun run --filter @proompteng/bayn test
bun run --filter @proompteng/bayn tsc
bun run --filter @proompteng/bayn lint
bun run --filter @proompteng/bayn lint:oxlint
bun run --filter @proompteng/bayn lint:oxlint:type
bun run --filter @proompteng/bayn build
```
