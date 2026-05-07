# Temporal Bun SDK Production Readiness Implementation Plan

_Last updated: May 5, 2026_

## Goal

Make `@proompteng/temporal-bun-sdk` the default Temporal choice for Bun-based
agents by turning the current project-proven runtime into a public,
repeatable, evidence-backed production library.

This is not a plan to load the official `@temporalio/worker` stack in Bun. The
SDK is a pure Bun implementation: package metadata only ships `dist`, `docs`,
`skills`, and `README.md`; package dependencies are protobuf/connect/Effect/TypeScript; and the
production verification gate rejects `@temporalio/worker`,
`@temporalio/core-bridge`, `node-gyp`, `dist/native`, and stale native Docker
paths.

## Actual Concern

The concern behind "not production ready" is not that Bun cannot load a Node
NAPI bridge. This SDK does not rely on that bridge.

The real concern is that Temporal worker correctness is a protocol and
determinism contract. The official SDK gets trust from Temporal-maintained Core,
long-running compatibility coverage, and years of production history. A pure
Bun worker can be production quality, but it must publish enough proof that:

- Workflow code cannot silently observe nondeterministic Bun/JS runtime state.
- Replay reconstruction matches real Temporal histories across feature and
  version combinations.
- Worker pollers, sticky queues, heartbeats, updates, shutdown, and retries hold
  under load, restart, and failure conditions.
- Protocol command materialization remains compatible with Temporal Server
  changes.
- Release artifacts make the package boundary, test results, and support matrix
  easy for agents and humans to verify.

The current library is already deployed and tested on the current infra. That
counts, but agents outside this project cannot infer it. The implementation
work is to convert private confidence into public, machine-checkable evidence.

## Code Read Findings

| Surface              | Current implementation                                                                                                                                                                                                                                                                                                                                       | Production gap to close                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package boundary     | `packages/temporal-bun-sdk/package.json` ships `dist`, `docs`, `skills`, and `README.md`; runtime dependencies are `@bufbuild/protobuf`, Connect, Effect, and TypeScript. `verify:production` runs `tests/packaging/manifest-packaging.test.ts`.                                                                                                             | Keep this as a release gate and publish the result in a release manifest so agents can prove the package is not a Node/native wrapper.                                                                                     |
| Worker runtime       | `src/worker/runtime.ts` owns config load, WorkflowService transport, workflow/activity pollers, sticky queues, deployment/build IDs, scheduler, metrics, plugins, graceful shutdown, determinism marker emission, and activity task lifecycle.                                                                                                               | Add restart/chaos/soak scenarios for poll cancellation, sticky cache drift, task-not-found, heartbeat failure, tuner changes, and shutdown during active workflow/activity tasks.                                          |
| Workflow execution   | `src/workflow/executor.ts` runs registered workflows through Effect, creates `WorkflowCommandContext`, evaluates queries, processes updates, and materializes success/failure commands.                                                                                                                                                                      | Add protocol golden tests that compare emitted commands and update protocol messages against captured histories and expected server-visible events.                                                                        |
| Determinism guard    | `src/workflow/determinism.ts` records command, random, time, signal, query, and update streams and throws `WorkflowNondeterminismError` on replay mismatch.                                                                                                                                                                                                  | Add async interleaving fuzz tests and query-mode negative tests. Query handlers must never read live time/randomness as a hidden side channel.                                                                             |
| Runtime guards       | `src/workflow/guards.ts` patches `Date`, `Date.now`, `Math.random`, `crypto.randomUUID`, `crypto.getRandomValues`, `fetch`, timers, `performance.now`, `WebSocket`, `process.env`, `Bun.env`, `Bun.spawn`, `Bun.nanoseconds`, `Bun.sleep`, `Bun.file`, `Bun.write`, `Bun.connect`, and `Bun.serve`; `WorkflowExecutor` requires strict guards in production. | Release gate includes runtime guard tests, query guard matrix, workflow lint tests, async fuzz artifacts, and semantic-readiness evidence for Bun async/runtime behavior.                                                  |
| Static workflow lint | `src/bin/lint-workflows-command.ts` walks workflow import graphs and denies unsafe imports/globals/member expressions. Tests cover `fetch`, `process.env`, `Bun.env`, Bun timer/file/socket APIs, captured `Date.now`, and importing client APIs from workflows.                                                                                             | Add rules for timers captured through aliases and keep expanding adversarial workflow-isolation cases as Bun exposes new runtime APIs. Make release CI fail if configured workflow entries are missing.                    |
| Replay               | `src/workflow/replay.ts` ingests real histories, applies full/delta determinism markers, reconstructs command history, tracks updates, and diffs mismatch metadata. Stored fixtures now cover the required replay feature tags, including signal/query/update, cancellation, search attributes, side effects, versioning, and workflow-task failure.         | Scale from the current gate-passing replay corpus to a larger versioned corpus that covers every supported command/event pair, sticky replay variants, old SDK versions, and additional Temporal Server/Bun/platform rows. |
| Integration          | `tests/integration/**` covers history replay, activity lifecycle, query-only workflows, signal/query, workflow updates, payload codecs, client resilience, worker ops, schedules, and worker runtime behavior behind `TEMPORAL_INTEGRATION_TESTS=1`.                                                                                                         | Split optional service-unavailable skips from release-blocking skips. In release CI, a missing dev server or unimplemented critical endpoint must fail instead of silently reducing coverage.                              |
| Load/soak            | `tests/integration/load/**` submits CPU, activity, and update workflows, checks throughput, sticky hit ratio, and poll p95 latency, and writes JSONL/report artifacts. `scripts/run-worker-soak.ts` wraps load iterations and now records baseline, worker-restart, sticky-cache-churn, update rejection/termination, and activity-cancellation smoke modes. | Add Temporal endpoint interruption, heartbeat RPC failure injection, and completed nightly/release soak evidence.                                                                                                          |
| CI                   | `.github/workflows/temporal-bun-sdk.yml` builds, lints, tests, runs replay-corpus, async-fuzz, load, soak smoke, semantic production verification, and uploads release artifacts.                                                                                                                                                                            | Add longer restart/chaos soak lanes before broadening support to new platforms, Temporal Server minors, or higher-throughput profiles.                                                                                     |

## Production Bar

The library becomes the obvious default when every release can point to a
single production-readiness artifact containing:

- Package boundary proof: no official Node worker dependency, no native bridge,
  no `node-gyp`, no `dist/native`, no stale native Docker path.
- Determinism proof: replay corpus result, async fuzz result, query/global guard
  matrix, and mismatch diagnostics samples.
- Protocol proof: command/update/query/signal/activity golden tests by Temporal
  Server version and SDK version.
- Operations proof: load and soak reports with throughput, latency, sticky cache
  ratio, heartbeat retries/failures, worker failures, memory slope, and restart
  outcomes.
- Compatibility proof: supported Bun, Temporal Server, Temporal Cloud, TLS/mTLS,
  payload codec, and deployment/versioning matrix.
- Support proof: documented feature status, known limits, upgrade policy,
  security/reporting contact, and release deprecation policy.

## Implementation Phases

### P0 - Credibility Gate And Public Evidence

Purpose: make the current hardening visible and stop regressions.

Implementation:

- Add `scripts/production-readiness/collect-release-evidence.ts`.
- Generate `dist/production-readiness.json` during `prepack`.
- Include package boundary, Bun/Temporal versions, git SHA, command results,
  replay fixture count, integration skip count, load report path, and docs hash.
- Extend `verify:production` to validate the generated evidence schema.
- Remove or rename stale `TODO(TBS-NDG-*)` comments once the matching tests prove
  they are complete; leave new TODOs only for real unfinished work.
- Add a release CI step that uploads `production-readiness.json` with npm pack
  output and worker-load artifacts.

Acceptance:

- `bun run --filter @proompteng/temporal-bun-sdk verify:production` fails if the
  evidence file is missing, malformed, or reports native/Node worker artifacts.
- `npm pack --dry-run --json` output can be matched to the same evidence file.
- Docs link to the evidence fields so agents can make a yes/no decision without
  reading the whole repo.

### P1 - Determinism And Async Semantics Audit

Purpose: answer the specific "Bun async semantics" concern.

Implementation:

- Add `tests/workflow/query-guard-matrix.test.ts`.
  - Assert `Date`, `Date.now`, `Math.random`, `crypto.randomUUID`,
    `crypto.getRandomValues`, `performance.now`, timers, fetch, WebSocket, and
    Bun process APIs either throw `WorkflowQueryViolationError` in query mode or
    replay from prior determinism state. No query path may read live wall-clock
    or random state.
- Add `tests/workflow/async-determinism-fuzz.test.ts`.
  - Generate seeded workflows that interleave Effect yields, Promise microtasks,
    timers via workflow APIs, activities, signals, queries, updates, sideEffect,
    getVersion, patch, and local activities.
  - Run each seed twice: initial execution records state; replay must produce
    identical output and zero `diffDeterminismState` mismatches.
  - Mutate one command/random/time/query/update slot per seed and assert the
    mismatch is detected with useful metadata.
- Extend `lint-workflows` rules to flag hidden async escape hatches:
  - raw `Promise` constructors in workflow modules unless allowlisted;
  - `Effect.tryPromise` and `Effect.promise` in workflow handlers unless called
    through SDK-provided deterministic adapters;
  - captured unsafe globals through aliases;
  - `eval`, `Function`, dynamic import, and Bun runtime APIs that expose live
    environment, timer, filesystem, socket, subprocess, or server state.
- Add a CLI gate that runs `temporal-bun lint-workflows` in strict JSON mode and
  writes `.artifacts/workflow-lint/report.json`.

Acceptance:

- Runtime guard, query guard matrix, and async fuzz suites pass locally and in
  CI.
- Fuzz default: at least 1,000 seeds in PR CI under a stable seed file.
- Fuzz release/nightly: at least 10,000 seeds with artifacted seed failures.
- Any workflow query reading live time/randomness is a release blocker.

### P2 - Replay Corpus Expansion

Purpose: prove replay against real Temporal histories, not only synthetic unit
fixtures.

Implementation:

- Add `tests/replay/corpus/manifest.json`.
  - Fields: fixture name, Temporal Server version, SDK version, Bun version,
    workflow type, feature tags, history event count, expected command count,
    payload codec profile, captured date, and source command.
- Add `scripts/replay/capture-corpus-fixture.ts`.
  - Starts or references a workflow, fetches history through WorkflowService or
    Temporal CLI, normalizes JSON, runs `ingestWorkflowHistory`, stores expected
    determinism state, and updates the manifest.
- Add `scripts/replay/verify-corpus.ts`.
  - Runs all fixtures, rejects empty corpus, rejects duplicate tags without a
    replacement marker, rejects unsupported schema versions, and writes
    `.artifacts/replay-corpus/report.json`.
- Keep the existing small `tests/replay/fixtures.test.ts`, but make the larger
  corpus the release gate.

Coverage targets:

- Activities: success, retry success, retry exhaustion, cancellation, heartbeat
  timeout, non-retryable failure, payload codec failure details.
- Timers: fire, cancel, replay after marker, long timeout normalization.
- Child workflows: start, complete, fail, cancel, terminate, timeout, pending
  child replay.
- Continue-as-new and versioning: marker chain, getVersion, patch/deprecate,
  old-build replay.
- Signals and queries: signal delivery order, query-only task, legacy query,
  multi-query, query failure.
- Updates: admitted, accepted, rejected, completed success/failure, duplicate
  update ID, cancellation while awaiting.
- Search attributes and memo: upsert and workflow properties modified.
- Nexus operations: schedule, complete, fail, cancel, timeout.
- Payload codecs: JSON, binary tunnel, gzip, AES-GCM, key rotation metadata.

Acceptance:

- PR gate: at least 25 high-signal corpus fixtures.
- Release gate: at least 75 fixtures covering every GA-critical command/event
  family.
- Default-choice gate: at least 150 fixtures across at least two Temporal Server
  minor versions and two SDK minor versions.

### P3 - Protocol Golden And Compatibility Tests

Purpose: prove the custom Bun worker emits server-compatible commands.

Implementation:

- Add `tests/protocol/command-golden.test.ts`.
  - Given workflow command intents, materialize commands and compare stable JSON
    projections of `Command` protos.
  - Include headers, memo, search attributes, retry policies, parent close
    policy, task queues, timeouts, cancellation, continue-as-new, and Nexus.
- Add `tests/protocol/update-protocol-golden.test.ts`.
  - Validate `buildUpdateProtocolMessages` output for acceptance, rejection,
    success completion, failure completion, and replay duplicate suppression.
- Add `tests/protocol/history-roundtrip.test.ts`.
  - For selected corpus fixtures, reconstruct determinism state, replay the
    workflow, materialize commands, and assert stable equivalence against the
    next command-bearing history events.
- Add a Temporal compatibility matrix job:
  - local dev server for PRs;
  - pinned Temporal Server minors in nightly;
  - Temporal Cloud smoke in release when credentials are present.

Acceptance:

- Every command kind in `src/workflow/commands.ts` has a golden projection.
- Every event kind handled in `src/workflow/replay.ts` has at least one corpus
  fixture or an explicit unsupported-status entry.
- Protocol golden tests fail on accidental protobuf field drift.

### P4 - Worker Lifecycle, Chaos, And Soak

Purpose: prove the runtime holds under real operating conditions.

Implementation:

- Extend `tests/integration/load/config.ts` with:
  - `TEMPORAL_LOAD_TEST_DURATION_MS`;
  - `TEMPORAL_LOAD_TEST_RESTART_INTERVAL_MS`;
  - `TEMPORAL_LOAD_TEST_ENDPOINT_BLACKHOLE_MS`;
  - `TEMPORAL_LOAD_TEST_STICKY_CHURN_RATIO`;
  - `TEMPORAL_LOAD_TEST_MEMORY_SLOPE_MAX_MB_PER_HOUR`;
  - `TEMPORAL_LOAD_TEST_SHUTDOWN_DURING_ACTIVITY_RATIO`.
- Extend `tests/integration/load/runner.ts` to:
  - sample RSS/heap and write `memory.jsonl`;
  - periodically shutdown and recreate `WorkerRuntime`;
  - interrupt pollers and confirm `#withRpcAbort` and scheduler shutdown do not
    strand tasks;
  - force sticky cache eviction and drift rebuilds;
  - track task-not-found, nondeterminism, heartbeat retry/failure, activity
    failure, workflow failure, and sticky heal metrics.
- Harden `scripts/run-worker-soak.ts`.
  - Duration-mode wrapper around the load runner with stricter artifact
    validation.
  - Current smoke mode records per-iteration load summaries, `memory.jsonl`,
    RSS/heap slope summaries, and coverage for baseline, worker-restart,
    sticky-cache-churn, update rejection/termination, and activity
    cancellation.
  - `tests/worker.task-queue-kind.test.ts` now directly holds normal workflow,
    sticky workflow, and activity long-poll RPCs open and verifies worker
    shutdown aborts every poll, flushes metrics, and reports a drained shutdown.
  - `worker-restart` now shuts down the active worker runtime after workflow
    submission, waits briefly, starts a replacement runtime on the same queue,
    and records restart events in the load and soak reports.
  - `activity-cancellation` cancels activity-heavy workflows while heartbeat
    activities are running and records cancellation attempts, successful
    cancellation calls, and terminal `CANCELED` workflow outcomes in the load
    and soak reports.
  - Remaining work is endpoint disconnect injection, heartbeat RPC failure
    injection, and completing the long-running release lanes with passing
    six-hour evidence.
- `.github/workflows/temporal-bun-sdk-nightly.yml` now provides the long-soak
  lane.
  - Runs 2-hour soak nightly.
  - Runs 6-hour soak in manual release mode.
  - Uploads long-soak and readiness artifacts.
  - Allows longer manual soak before broadening platform or throughput support.

Acceptance:

- PR load smoke: current short load test remains under 10 minutes.
- Nightly soak: 2 hours, zero stuck workflows, no unhandled runtime rejection,
  memory slope below threshold, sticky heal rate below threshold, and all
  metrics artifacts uploaded.
- Release soak: 6 hours against pinned Temporal Server with restart mode
  enabled.
- Default-choice release smoke: CI soak artifact present and validated by
  `verify:production`; extended soak is required for unusual workload or
  platform risk.

### P5 - CI Skip Policy And Release Blocking Rules

Purpose: prevent false confidence from skipped integration tests.

Implementation:

- Add a test reporter that counts Bun skipped tests and scenario-level "skipped"
  console warnings for the SDK package.
- Add `TEMPORAL_BUN_RELEASE_GATE=1`.
  - In release mode, missing Temporal CLI/dev server, missing corpus fixtures,
    and critical integration skips are failures.
  - Optional external services remain optional only if the skip is tagged with a
    non-critical capability, for example Temporal Cloud Ops without credentials.
- Split integration suites into:
  - `test:integration:critical`;
  - `test:integration:optional`;
  - `test:load`;
  - `test:soak`.
- Publish `.artifacts/temporal-bun-sdk/test-summary.json`.

Acceptance:

- Release CI fails if a critical integration test silently skips.
- The release manifest includes skip counts by suite and reason.
- PR CI remains usable without requiring Temporal Cloud credentials.

### P6 - Docs, Support Policy, And Agent Default Metadata

Purpose: make choosing the SDK easy and defensible.

Implementation:

- Add `docs/support-policy.md`.
  - Supported Bun versions, Temporal Server versions, Temporal Cloud support,
    OS/arch, payload codecs, known limits, security reporting, and deprecation
    policy.
- Add `docs/feature-matrix.md`.
  - Feature status with test/corpus references and unsupported/experimental
    labels.
- Add `docs/agent-adoption-guide.md`.
  - Short guidance for agents: when to choose `@proompteng/temporal-bun-sdk`,
    required gates, project scaffolding command, Docker command, and fallback
    criteria.
- Add `dist/agent-readiness.json`.
  - `recommended: true` only when the production-readiness artifact meets all
    default-choice thresholds.
  - Include machine-readable gate names, versions, artifact paths, and known
    limits.
- Update `apps/docs/content/docs/temporal-bun-sdk.mdx` and
  `apps/docs/content/docs/temporal-bun-sdk-comparison.mdx` to link the evidence
  instead of asking users to trust prose.

Acceptance:

- An agent can answer "is this the default Bun Temporal SDK?" by reading
  `agent-readiness.json` plus the release manifest.
- Public docs explain the actual concern: pure Bun worker correctness proof and
  support policy, not Node NAPI removal.
- The comparison page no longer leaves "production ready" as an ambiguous
  phrase.

## Gate Matrix

| Gate                 | Command                                                           | PR                        | Release           | Default-choice                |
| -------------------- | ----------------------------------------------------------------- | ------------------------- | ----------------- | ----------------------------- |
| Package boundary     | `bun run --filter @proompteng/temporal-bun-sdk verify:production` | required                  | required          | required                      |
| Build                | `bun run --filter @proompteng/temporal-bun-sdk build`             | required                  | required          | required                      |
| Unit/runtime guards  | `bun test tests/workflow/runtime-guards.test.ts`                  | required                  | required          | required                      |
| Query guard matrix   | `bun test tests/workflow/query-guard-matrix.test.ts`              | required                  | required          | required                      |
| Async fuzz           | `bun test tests/workflow/async-determinism-fuzz.test.ts`          | 1k seeds                  | 10k seeds         | 10k+ seeds, last 7 days green |
| Replay corpus        | `bun scripts/replay/verify-corpus.ts`                             | 25 fixtures               | 75 fixtures       | 150 fixtures                  |
| Protocol golden      | `bun test tests/protocol/*.test.ts`                               | required                  | required          | required                      |
| Critical integration | `TEMPORAL_INTEGRATION_TESTS=1 bun test tests/integration`         | required                  | no critical skips | no critical skips             |
| Load smoke           | `bun run --filter @proompteng/temporal-bun-sdk test:load`         | required                  | required          | required                      |
| Soak                 | `bun scripts/run-worker-soak.ts`                                  | optional                  | 6h                | 24h                           |
| Docs                 | `bun run --filter docs build`                                     | required when docs change | required          | required                      |
| Pack                 | `npm pack --dry-run --json`                                       | optional                  | required          | required                      |

## First Implementation Order

1. **P0 evidence manifest.** This is the fastest way to make the already-shipped
   production boundary and current CI/load results visible to agents.
2. **P1 query/async guard tests.** This directly answers the ChatGPT concern
   about Bun async semantics and hidden nondeterminism.
3. **P2 replay corpus runner.** This converts the existing replay engine into
   durable proof across real histories.
4. **P3 protocol golden tests.** This protects the pure-Bun command
   materializer from Temporal protobuf/server drift.
5. **P4 soak mode.** This moves the load harness from a smoke test to
   operational proof.
6. **P6 agent metadata.** Only mark the SDK as default when the evidence gates
   are green, not because the docs claim it.

## Non-Goals

- Running `@temporalio/worker` on Bun.
- Depending on Node NAPI, `@temporalio/core-bridge`, `node-gyp`, or a native
  worker bundle.
- Byte-for-byte equivalence with the official SDK internals.
- Hiding unsupported features. Missing compatibility should be listed in the
  feature matrix and reflected in `agent-readiness.json`.

## Definition Of Done

The SDK is production-default for agents when:

- `agent-readiness.json` says `recommended: true`.
- The latest release manifest proves all default-choice gates are green.
- The replay corpus covers every GA-critical workflow/event family.
- Async fuzz and query guard tests have no open determinism escapes.
- Load and soak artifacts are linked from release artifacts and validated by
  `verify:production`.
- Docs and comparison pages explain that this is a pure Bun SDK with public
  evidence, not an unofficial wrapper around the Node worker.
