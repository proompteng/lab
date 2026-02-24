# Temporal Bun SDK – Production-Ready Design

_Last updated: November 13, 2025_

## Purpose

This document is the single source of truth for taking `@proompteng/temporal-bun-sdk`
to a generally available release on npm that can be trusted by millions of
Temporal developers. It records what already ships in `main`, what gaps remain,
and the quality bars we must meet before GA.

## Bun-First Architecture Advantages

- **Single runtime, single language.** Workflows, activities, worker runtime, and tooling all execute inside Bun with Effect layers, so we avoid C-ABI bridges, reference-counted native handles, or “core” background threads. Scheduling, sticky cache eviction, and heartbeat aggregation share the same event loop, which keeps failure handling and telemetry consistent.
- **Zero workflow bundler constraints.** Because workflows run in the same runtime, we don’t need webpack-only bundles, module blacklists, or VM cache hacks. The CLI can still emit bundles for deployment, but local dev can import workflows/activities directly without rewriting entrypoints or duplicating payload converter wiring.
- **Direct telemetry plumbing.** Loggers, metrics, and tracing consumers plug into Effect services rather than going through gRPC proxies or shared heartbeat workers. This lets us emit structured observability data per task without extra polling loops and keeps configuration (logger sinks, OTLP exporters) co-located with the worker config.
- **Simpler lifecycle management.** Worker run/drain/shutdown flows are just Effect scopes with managed resources, so we don’t need special singleton installers, `NativeWorker` mirrors, or asynchronous “activation processor” threads. Graceful shutdown (drain → cancel → fail) is encoded once and reused in both CLI and embedding scenarios.
- **Determinism-friendly developer experience.** With workflows, activities, and data converters sharing the same dependency graph, we can enforce deterministic imports and snapshotting at build time, but developers still get Bun’s tooling (watch mode, test runner) without cross-language debugging.

## Current State Snapshot

| Area               | Status    | Notes                                                                                                                                                                       |
| ------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow execution | **Alpha** | Deterministic command context, activity/timer/child/signal/continue-as-new intents, deterministic guard.                                                                    |
| Worker runtime     | **Beta**  | Sticky cache routing performs drift detection + healing; Effect-based scheduler with configurable concurrency; observability/logging/heartbeat telemetry wired via TBS-004. |
| Client             | **Beta**  | Start/signal/query/cancel/update/describe namespace with Connect transport; effect-layered interceptors, retries, and telemetry shipped.                                    |
| Activities         | **Beta-** | Handler registry, cancellation signals. Heartbeats, retries, and failure categorisation remain.                                                                             |
| Tooling & docs     | **Beta-** | Replay runbook + history capture automation documented; CLI scaffolds projects and Docker image. Remaining doc gaps outside TBS-001.                                        |
| Testing            | **Beta**  | Determinism regression harness (`tests/replay/**`) plus Temporal CLI integration suite (`tests/integration/history-replay.test.ts`); load/perf smoke tests still pending.   |

> **Release target:** GA requires all sections below marked as **Critical for GA**
> to be complete, with supporting validation and documentation.

## Architecture Overview

- **Workflow Runtime (`src/workflow/*`)**
  - _Shipped:_ Deterministic workflow context, command intents, determinism guard.
  - _GA requirements:_ History replay ingest, failure categorisation, command metadata (headers/memo/search attributes), workflow cache eviction strategy.
- **Worker Runtime (`src/worker/*`)**
  - _Shipped:_ Single-threaded pollers, deterministic snapshot persistence per run.
  - _GA requirements:_ Configurable concurrency, sticky task queues, build-id routing, graceful shutdown with drain, heartbeat plumbing, metrics/logging hooks.
- **Client (`src/client.ts`)**
  - _Shipped:_ Connect WorkflowService client with payload conversion, header normalisation, and effect-layered interceptors for retries/auth/metrics/tracing.
  - _GA requirements:_ TLS/auth hardening, memo/search attribute helpers, long-running operation ergonomics.
- **Activities (`src/activities/*`, `src/worker/activity-context.ts`)**
  - _Shipped:_ AsyncLocalStorage-based context, cancellation surface.
  - _GA requirements:_ Heartbeat API, retry policy adherence, progress payload encoding, failure classification.
- **Tooling**
  - CLI (`src/bin/temporal-bun.ts`) scaffolds projects; needs connectivity checks, history replay tooling, lint hooks.
- **Generated Protos (`src/proto/**`)\*\*
  - Must stay synced with upstream Temporal releases; add automation for updates.

## Functional Roadmap

| Capability         | Status                           | Acceptance Criteria                                                                                                        | GA Critical? |
| ------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------ |
| Command coverage   | ✅ context + intents             | Activities, timers, child workflows, signals, continue-as-new emit correct commands with metadata and retries.             | Yes          |
| History replay     | ✅ ingestion + sticky cache      | Worker hydrates history into determinism state, verifies commands, tolerates sticky cache eviction, exposes replay API.    | Yes          |
| Activity lifecycle | ✅ complete                      | Heartbeats, retries, cancellation reasons, eager activities.                                                               | Yes          |
| Worker concurrency | ✅ scheduler + sticky queues     | Configurable parallelism, sticky queues, build-id routing, per-namespace/task queue isolation.                             | Yes          |
| Client resilience  | ✅ complete                      | Retry policies, interceptors, TLS/mTLS test matrix, structured errors.                                                     | Yes          |
| Diagnostics        | ✅ logs + metrics (tracing next) | Effect-based logger + metrics exporters ship with worker/client runtimes; tracing hooks scheduled separately.              | Yes          |
| Testing & QA       | ✅ replay + integration          | Deterministic regression suite, integration tests with Temporal dev server; load/perf smoke tests still pending.           | Yes          |
| Tooling            | ✅ complete                      | CLI connectivity check, replay CLI, proto regeneration script, API docs generator.                                         | No (Beta)    |
| Documentation      | ✅ complete                      | Architecture guide, workflow/activities best practices, migration guide, troubleshooting, accessibility for CLI.           | Yes          |
| Release operations | ✅ automated                     | Trusted release workflows (prepare/publish), release-please changelog automation, npm provenance publishing, support SLAs. | Yes          |

Legend: ✅ complete, 🚧 in progress/planned.

## Work Breakdown & TODO Map

Each deliverable is tracked with a `TBS-xxx` identifier. New scaffolding and TODO
comments in the repository reference these IDs so multiple Codex runs can execute
in parallel without collisions.

| ID          | Epic                              | Description                                                                                                                           | Primary Modules                                                                           |
| ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **TBS-001** | History Replay                    | Build history ingestion, determinism snapshot persistence, mismatch diagnostics.                                                      | `src/workflow/replay.ts`, `src/worker/sticky-cache.ts`, `src/worker/runtime.ts`           |
| **TBS-002** | Activity Lifecycle (✅)           | Heartbeat helper wired to WorkflowService with retry/cancellation, local retry orchestration, enriched cancellation metadata.         | `src/activities/lifecycle.ts`, `src/worker/activity-runtime.ts`                           |
| **TBS-003** | Worker Concurrency                | Add scheduler for concurrent workflow/activity processors, sticky queues, build-id routing.                                           | `src/worker/concurrency.ts`, `src/worker/runtime.ts`                                      |
| **TBS-004** | Observability                     | Emit structured logs, metrics, and tracing hooks across client/worker.                                                                | `src/observability/logger.ts`, `src/observability/metrics.ts`                             |
| **TBS-005** | Client Resilience                 | Layered retries, interceptors, TLS/auth validation, memo/search helpers.                                                              | `src/client/interceptors.ts`, `src/client/retries.ts`                                     |
| **TBS-006** | Integration Harness               | Temporal dev-server automation, replay regression suite, load tests.                                                                  | `tests/integration/harness.ts`, `tests/replay/*.ts`                                       |
| **TBS-007** | CLI Tooling                       | `temporal-bun doctor`, `temporal-bun replay`, proto regeneration script.                                                              | `src/bin/temporal-bun.ts`, `scripts/proto/update-temporal-protos.ts`                      |
| **TBS-008** | Documentation & DX                | Architecture guide, cookbook, migration path, CLI accessibility.                                                                      | `apps/docs/content/docs/temporal-bun-sdk.mdx`, `docs/*`                                   |
| **TBS-009** | Release Automation                | CI workflows, changelog, signed publish, support policy artifacts.                                                                    | `.github/workflows/temporal-bun-sdk.yml`, `packages/temporal-bun-sdk/CHANGELOG.md`        |
| **TBS-010** | Effect Architecture               | Migrate worker/client/config/runtime to Effect Layers, structured dependency injection, and fiber supervision.                        | `src/runtime/effect-layers.ts`, `src/worker/runtime.ts`, `src/client.ts`, `src/config.ts` |
| **TBS-011** | Payload Codec & Failure Converter | Layered DataConverter with ordered codecs (gzip + AES-GCM), structured failure converter, doctor validation, and observability hooks. | `src/common/payloads/**`, `src/client.ts`, `src/worker/runtime.ts`, `docs/*`              |

> **Implementation rule:** Every work item must create or update code that carries
> a `// TODO(TBS-xxx): ...` marker. Leave stubs effect-safe and executable even
> before full implementation (e.g., return `Effect.fail` with descriptive
> placeholders).

## Execution Playbooks

Each playbook below describes the entry points, primary TODOs, recommended
Effect primitives, acceptance tests, and hand-offs so individual Codex instances
can contribute independently without re-planning.

### Effect-First Architecture Principles (TBS-010 umbrella)

- All long-running flows (polling, scheduling, replay, CLI commands) should be
  expressed as `Effect` programs; avoid raw `async`/`await`.
- Dependencies (Temporal config, WorkflowService client, logger, metrics, sticky
  cache, scheduler) should be provided via `Layer`/`Context`.
- Use `Scope` and supervised fibres for worker lifecycle management; no manual
  `AbortController`.
- Logging/metrics must route through Effect services, not `console`.
- Configuration parsing should use `Schema` and `Effect.try` to surface errors
  effectfully.
- Manual loops should leverage `Effect.repeat`, `Stream`, or `Queue` primitives
  to gain back-pressure and cancellation.

#### Layered bootstrap modules

- `src/runtime/cli-layer.ts` merges the config, observability, and WorkflowService
  layers for CLI tooling. `runTemporalCliEffect` executes arbitrary Effect
  programs with Temporal env vars (doctor, replay, smoke tests) without
  hand-wiring `loadTemporalConfig`.
- `src/runtime/worker-app.ts` composes config + observability + WorkflowService +
  worker runtime layers and exposes `runWorkerApp`. Host apps can now start the
  worker purely through `Effect.scoped` (no manual `createWorker` + `AbortController`).

### TBS-010 – Effect Architecture

- **Starting points**
  - `src/runtime/effect-layers.ts` – declare shared `Layer`s for config, logger,
    metrics, WorkflowService client, sticky cache, scheduler.
  - `src/worker/runtime.ts` – refactor to consume layers instead of raw Promises.
  - `src/client.ts` – expose construction via Effect Layer, adopt interceptors/retries.
  - `src/config.ts` – convert loader to Effect + Schema validation.
- **Effect guidance**
  - Use `Layer.scoped`/`Layer.effect` to manage resources (clients, transports).
  - Replace manual `AbortController` with `Scope` and `Fiber` interruption.
  - Propagate structured errors via `Effect.fail`.
- **Acceptance criteria**
  1. Worker run/shutdown implemented as `Effect` programs (no raw `Promise` orchestration).
  2. Config, logger, metrics, WorkflowService client available via `Layer`.
  3. CLI and tests can bootstrap runtime by providing layers.
  4. Documentation updated with Layer usage patterns.
- **Dependencies**
  - Enables observability (TBS-004), concurrency (TBS-003), and client resilience (TBS-005) to plug into shared services.

### TBS-011 – Payload Codec & Failure Converter

- **Starting points**
  - `src/common/payloads/*` – introduce ordered codec chain + failure converter wired through the Effect `DataConverter` layer.
  - `src/config.ts` – schema + env parsing for `payloadCodecs` (`TEMPORAL_PAYLOAD_CODECS=gzip,aes-gcm`, `TEMPORAL_CODEC_AES_KEY`, optional `TEMPORAL_CODEC_AES_KEY_ID`).
  - `src/client.ts`, `src/worker/runtime.ts` – resolve codec chain from config, expose metrics/logging around codec successes/failures.
  - `src/bin/temporal-bun.ts` – doctor command validates codec configuration and reports chain summary.
- **Acceptance criteria**
  1. Payload converter supports ordered codecs (gzip + AES-GCM built-in) with replay-safe envelopes; extension point for additional codecs.
  2. Failure converter maps Temporal `Failure` messages to structured `TemporalFailureError` with details/cause decoded via codec pipeline.
  3. Worker/client route all payloads (workflow args, activities, queries/updates, memo/search attributes, determinism markers) through the layered converter.
  4. Observability: counters for codec encode/decode/errors and structured logging for misconfiguration; `temporal-bun doctor` surfaces codec chain and fails fast on invalid keys.
- **Operational notes**
  - Default remains JSON-only; enable codecs via config/env to avoid breaking existing users.
  - AES-GCM keys must be 128/192/256-bit (base64/hex); key IDs travel in payload metadata for rotation.
  - Determinism: codecs wrap the entire payload proto, so workflow replay is safe as long as the codec chain remains stable for a given history.

### TBS-001 – History Replay & Sticky Cache

- **Status**: ✅ Completed (November 2025) — determinism replay ingestion, sticky cache eviction/metrics, and the integration + replay harnesses now live on `main`.
- **Starting points**
  - `src/workflow/replay.ts` – implement `ingestWorkflowHistory` and
    `diffDeterminismState`.
  - `src/worker/sticky-cache.ts` – replace placeholder eviction strategy, expose metrics.
  - `src/worker/runtime.ts` – wire cache into poll loop, use `ingestWorkflowHistory`
    before executing tasks.
- **Effect guidance**
  - Use `Effect.gen` and `Stream` to process histories incrementally if needed.
  - Surface diagnostics through `Effect.fail` with rich error payloads.
- **Acceptance criteria**
  1. Determinism state reconstructed from Temporal history (coverage includes timer,
     activity, child workflow events).
  2. Sticky cache persists state across multiple workflow tasks + evicts per policy.
  3. Replay mismatch yields `WorkflowNondeterminismError` that includes event IDs
     and mismatched command signatures.
  4. Unit tests and dev-server scenario verifying behaviour. (Covered by `tests/workflow/replay.test.ts`, `tests/replay/fixtures.test.ts`, and `tests/integration/history-replay.test.ts`.)
- **Implementation notes**
  - Determinism snapshots are persisted as `temporal-bun-sdk/determinism` record markers (schema v1) that bundle command history, random/time streams, and the last processed event id. The marker payload is stored via the configured `DataConverter`.
  - `TEMPORAL_STICKY_CACHE_SIZE` and `TEMPORAL_STICKY_TTL_MS` control cache capacity and eviction; the sticky worker queue schedule-to-start timeout inherits from the TTL so increasing it lengthens deterministic affinity.
  - `tests/integration/harness.ts` provides a Temporal CLI-backed harness that starts the dev server, executes workflows (`temporal workflow execute`), fetches JSON history (`temporal workflow show --output json`), and feeds the ingestion pipeline. Tests log a skip when the CLI is unavailable instead of failing hard.
  - Sticky cache decisions are now instrumented with counters (`hits`, `misses`, `evictions`, `heal`) and structured logs so nondeterminism causes can be traced via `WorkflowNondeterminismError.details`.
  - Replay fixtures live under `tests/replay/fixtures/*.json` with a dedicated harness (`tests/replay/fixtures.test.ts`) that locks determinism outputs to real histories. The capture/runbook lives in `docs/replay-runbook.md`.
- **Validation commands**
  - `cd packages/temporal-bun-sdk && bun test tests/workflow/replay.test.ts`
  - `cd packages/temporal-bun-sdk && bun test tests/replay/fixtures.test.ts`
  - `cd packages/temporal-bun-sdk && bun test tests/integration/history-replay.test.ts`

- **Dependencies**
  - Optional integration with TBS-004 for logging metrics.
  - Provides determinism snapshot for TBS-003 scheduler.

### TBS-002 – Activity Lifecycle

- **Starting points**
  - `src/activities/lifecycle.ts` – flesh out `registerHeartbeat` (wire to Temporal)
    and `nextRetryDelay` (match Temporal retry spec).
  - `src/worker/runtime.ts` – integrate heartbeats and retries when processing activity tasks.
- **Effect guidance**
  - Wrap heartbeats in `Effect.retry` with exponential backoff aligned to server timeouts.
  - Use `Effect.timeout` for heartbeat intervals, store state in `Ref`.
- **Acceptance criteria**
  1. Heartbeat API emits to Temporal dev server and respects configured interval.
  2. Retry logic honours `WorkflowRetryPolicy` (initial + max intervals, backoff coefficient,
     non-retryable errors, attempt capping).
  3. Cancellation semantics propagate reason/last heartbeat details to handlers.
  4. Integration tests covering heartbeat timeout and retry exhaustion.
- **Dependencies**
  - Exposes metrics/log hooks for TBS-004.
  - Scheduler from TBS-003 can leverage retry/backoff outputs.

### TBS-003 – Worker Concurrency & Sticky Queues

- **Starting points**
  - `src/worker/concurrency.ts` – expand scheduler, implement graceful shutdown,
    integrate metrics.
  - `src/worker/runtime.ts` – replace serial loops with scheduler enqueues, manage
    sticky queue identities.
- **Effect guidance**
  - Use `Queue`, `Semaphore`, or `Channel` for concurrency control.
  - Manage fibre lifecycle with `Scope` for deterministic teardown.
  - Coordinate with TBS-010 to ensure scheduler runs inside Effect Layer.
- **Acceptance criteria**
  1. ✅ Configurable concurrency levels (workflow/activity) via config/env (`TEMPORAL_WORKFLOW_CONCURRENCY`, `TEMPORAL_ACTIVITY_CONCURRENCY`).
  2. ✅ Sticky task affinity using cache (TBS-001) with eviction metrics and tunable size/TTL (`TEMPORAL_STICKY_CACHE_SIZE`, `TEMPORAL_STICKY_TTL_MS`).
  3. ✅ Build-id routing respected when scheduling tasks (deployment name defaults to `<task-queue>-deployment`; build ID via `TEMPORAL_WORKER_BUILD_ID` or a derived value).
  4. ✅ Graceful shutdown drains tasks; observability hooks from TBS-004 now emit lifecycle logs + metrics during drain.
  5. ✅ Load/perf harness (`tests/integration/worker-load.test.ts` and `scripts/run-worker-load.ts`) saturates workflow + activity pollers, enforces throughput/poll-latency/sticky-cache thresholds, and emits `.artifacts/worker-load/{metrics.jsonl,report.json}` for CI review.
- **Dependencies**
  - Consumes determinism cache (TBS-001), emits metrics for TBS-004.

- **Load/perf harness**
  - CPU-heavy + I/O-heavy workflows live under `tests/integration/load/**` alongside the JSONL metrics aggregator. The harness starts the Temporal CLI dev server, creates `.artifacts/worker-load` per run, and collects sticky cache, poll latency, and throughput metrics via the worker runtime's file exporter.
  - Local runs: `cd packages/temporal-bun-sdk && TEMPORAL_INTEGRATION_TESTS=1 bun test tests/integration/worker-load.test.ts` (Bun test runner) or `cd packages/temporal-bun-sdk && bun run test:load` (Bun CLI script).
  - CI: `.github/workflows/temporal-bun-sdk.yml` now executes `cd packages/temporal-bun-sdk && bun run test:load` after the main suite and uploads the `.artifacts/worker-load/{metrics.jsonl,report.json,temporal-cli.log}` bundle for reviewers.
  - Default knobs submit 36 workflows with a 100s completion budget and workflow/activity concurrency of 10/14; the Bun test adds a ~15s cushion over `TEMPORAL_LOAD_TEST_TIMEOUT_MS + TEMPORAL_LOAD_TEST_METRICS_FLUSH_MS` so that healthy runs finish well before the CI hard timeout while still exercising the scheduler.

### TBS-004 – Observability (Complete)

- **Highlights**
  - Introduced logger/metrics layers with format/level controls, pluggable exporters, and shared helpers for counters/histograms.
  - Worker and client runtimes consume the new services, emitting sticky cache, poll latency, heartbeat, and failure metrics while logging lifecycle events.
  - `runTemporalCliEffect` wires config + observability layers so `temporal-bun doctor` validates env overrides, emits structured logs, and flushes exporter sinks without bespoke bootstrap.
  - SDK docs and production design guidance cover the telemetry knobs and show the `bunx temporal-bun doctor --log-format=json --metrics=file:/tmp/metrics.json` validation path.
- **Effect guidance**
  - Observability services are built with `Effect` so they can be composed or swapped (layers remain available for future TBS-010 work).
  - Metrics exporters flush through `Effect` effects to avoid blocking shutdown.
- **Validation notes**
  1. `cd packages/temporal-bun-sdk && bun test packages/temporal-bun-sdk/tests/**/*` now exercises the new observability unit/integration suites.
  2. `cd packages/temporal-bun-sdk && bunx temporal-bun doctor --log-format=json --metrics=file:/tmp/metrics.json` confirms the documented configuration path and writes benchmark output.

### TBS-005 – Client Resilience

- **Starting points**
  - `src/client/interceptors.ts`, `src/client/retries.ts`, integrate with `src/client.ts`.
  - Add memo/search attribute helpers and TLS validation improvements.
- **Effect guidance**
  - Compose retries using `withTemporalRetry`.
  - Provide client access via Effect Layer (TBS-010).
  - Expose interceptors as `Effect<Interceptor[]>`, applying logging/metrics.
- **Acceptance criteria**
  1. Retries follow Temporal best practices and are configurable.
  2. Interceptors provide logging, metrics, and custom header hooks.
  3. TLS/auth path verifies cert chains, surfaces actionable errors.
  4. Client API exposes helper methods for memo/search attributes.

### TBS-006 – Integration Harness & Replay Suite

- **Starting points**
  - `tests/integration/harness.ts`, `tests/replay/`.
  - Add Bun scripts to orchestrate Temporal dev server (CLI or docker-compose).
- **Effect guidance**
  - Harness should use `Managed`/`Layer` for setup/teardown.
  - Replay suite should re-use `ingestWorkflowHistory` to assert determinism.
- **Acceptance criteria**
  1. CLI command (`bun test:integration` or similar) spins up dev server, runs scenarios.
  2. Replay suite replays stored histories, fails on non-determinism.
  3. Load test baseline recorded (CPU/memory/poll latency metrics).

### TBS-007 – CLI Tooling

- **Starting points**
  - `src/bin/temporal-bun.ts` – add new subcommands.
  - `scripts/update-temporal-protos.ts` – implement regeneration flow.
- **Effect guidance**
  - Each CLI command should be effectful with proper exit codes (no raw `process.exit`); plug into Effect runtime (TBS-010).
  - Use `Effect` to orchestrate external processes (`Bun.spawn`, `Effect.tryPromise`).
- **Acceptance criteria**
  1. `temporal-bun doctor` validates config connectivity and prints diagnostics.
  2. `temporal-bun replay` replays history files **and** live executions (Temporal CLI → WorkflowService fallback), reuses TBS-001 ingestion, emits metrics/logs/JSON summaries, and ships with unit + integration coverage.
  3. Proto update script takes version argument and regenerates stubs idempotently.

### TBS-008 – Documentation & DX

- **Starting points**
  - `apps/docs/content/docs/temporal-bun-sdk.mdx`, `docs/*`.
  - Update example app to mirror deterministic APIs (`packages/temporal-bun-sdk-example`).
- **Acceptance criteria**
  1. Architecture guide includes diagrams and determinism explanations.
  2. Cookbook recipes for activities, timers, signals, updates, heartbeats.
  3. Migration doc from Zig/Rust bridge.
  4. CLI docs reflect new commands and accessibility considerations.
  5. Example project README documents runtime prerequisites, configuration requirements,
     and Effect usage expectations so consumers can adopt the SDK confidently.
- **Implementation notes (Nov 15, 2025)**
  - `apps/docs/content/docs/temporal-bun-sdk.mdx` now anchors the docs hierarchy:
    architecture overview, configuration, tutorials/recipes, CLI/tooling, and
    troubleshooting/GA roadmap sections live on that page until navigation gains
    discrete entries.
  - CLI reference, proto regeneration notes, and replay/TLS troubleshooting
    guidance were added so engineers no longer have to mine the README for
    operational context.
  - GA blockers called out in the public docs must stay in sync with this design
    file; any time a TBS item ships, update both locations.
- **Open documentation work**
  - Break the long-form MDX file into sub-pages once the docs nav supports it
    (Overview, Tutorials, Configuration, CLI & Tooling, Troubleshooting, Release
    Notes).
  - Add diagrams/screenshots, cookbook snippets, and migration guidance per the
    acceptance criteria above.

### TBS-009 – Release Automation

- **Status**: ✅ Completed on 2025-11-17. `temporal-bun-sdk.yml` now gates every
  release via release-please, Oxfmt/unit/load suites, and npm trusted publishing
  with provenance so `main` publishes are reproducible (v0.2.0 shipped through
  the pipeline the same day).
- **Highlights**
  - release-please prepare job opens the automated release PR, runs validation
    suites against `release-please--branches--main--components--temporal-bun-sdk`,
    and updates `CHANGELOG.md`/`package.json`.
  - Publish job upgrades npm to ≥11.5, relies on GitHub OIDC trusted publishing
    (no automation token), reenforces all tests/builds, and runs `npm publish
--provenance --tag <dist>`.
  - `packages/temporal-bun-sdk/docs/release-runbook.md` documents the flow, while
    the proto regeneration workflow keeps generated sources aligned with upstream.
- **Starting points**
  - `.github/workflows/temporal-bun-sdk.yml` – dual-mode workflow: `prepare`
    triggers release-please to open/update the release PR and run validation
    suites; `publish` runs npm publish with provenance directly from `main`.
  - `.github/workflows/temporal-bun-sdk-protos.yml` – standalone proto
    regeneration job that creates a `chore/temporal-bun-sdk-proto-regen` PR when
    upstream APIs change.
  - `release-please-config.json` + `.release-please-manifest.json` – configure
    release-please (`node` release type) for `packages/temporal-bun-sdk`.
  - `packages/temporal-bun-sdk/CHANGELOG.md` – canonical changelog kept current
    by release-please.
- **Acceptance criteria (met)**
  1. The release workflow installs Node 24 + Bun, runs `bun install --frozen-lockfile`, executes `bunx oxfmt --check packages/temporal-bun-sdk`, `bun test`, `bun run test:load`, and `bun run build`. Any failure aborts the
     publish.
  2. release-please derives the semver bump from Conventional Commits, updates
     `package.json`, and rewrites `CHANGELOG.md` inside the automated release PR.
  3. Publishing uses GitHub OIDC + `npm publish --provenance --access public`
     with a scoped automation token, and emits an attestation/SBOM artifact.
  4. Prepare mode runs build/test/load suites against the release-please branch
     (`release-please--branches--main--components--temporal-bun-sdk`) so the PR
     contains validated artifacts, while the dedicated proto workflow keeps
     generated sources in sync.
  5. Publish mode exposes a `workflow_dispatch` dry-run path, references
     `security@proompteng.ai` for disclosures, and requires maintainers to link
     execution logs/artifacts before requesting review.

## Component Designs

### Workflow Runtime

1. **Deterministic context (shipped)**
   - Command intents: `schedule-activity`, `start-timer`, `start-child-workflow`,
     `signal-external-workflow`, `continue-as-new`.
   - Determinism guard captures command history, `Math.random()` and `Date.now()`
     usage for replay validation.
   - Deterministic context is enforced for all workflows and cannot be disabled.
2. **Replay ingestion (GA critical, TBS-001)**
   - Extract command history, random/time snapshots from Temporal history events.
   - Maintain per-run snapshot (`namespace::workflowId::runId`) accessible across
     polls and sticky cache transfers.
   - Surface mismatch details via `WorkflowNondeterminismError` enriched with
     event IDs.
3. **Command metadata & schema validation (TBS-001/TBS-005)**
   - Enforce schema-based validation for headers, memo, search attributes, retry
     policies, and backoffs.
   - Provide helper layers for common patterns (timeouts, workflows-by-task queue).
4. **Workflow cache management**
   - Implement LRU cache to retain determinism snapshots for sticky tasks; evict on
     memory pressure with graceful degradation.

### Activity Execution

1. **Handler registration (shipped)**
   - Map-based registry with AsyncLocalStorage context and cancellation support.
2. ✅ **Retries & heartbeats (TBS-002)**
   - WorkerRuntime uses the lifecycle helper to emit throttled heartbeats via `RecordActivityTaskHeartbeat`, retry transient RPC failures, and propagate server-side cancellation through the `ActivityContext`.
   - Local activity retries mirror the `WorkflowRetryPolicy` (initial/max interval, backoff coefficient, maximum attempts, non-retryable error types, schedule-to-close bounds) before surfacing a terminal failure flagged as non-retryable.
   - `activityContext.heartbeat(...details)` is now available to user code; details and cancellation reasons flow into `RespondActivityTaskCanceled/Failed` for Temporal UI parity.
   - Covered by `tests/activities/lifecycle.test.ts` and the Temporal CLI harness suite (`tests/integration/activity-lifecycle.integration.test.ts`) which exercises steady-state heartbeats, heartbeat timeouts, and retry exhaustion.
3. **Cancellation semantics**
   - Distinguish graceful vs. failure cancellations, propagate context to handlers.
4. **Metrics and structured logging**
   - Expose activity execution spans, attempt counts, and latencies.

### Worker Runtime

1. **Polling loops (shipped)**
   - Workflow/activity poll loops with deterministic snapshot storage.
2. **Concurrency & sticky queues (GA critical, TBS-003)**
   - Configurable poller counts, run-multiple workflows concurrently with safe
     determinism state transitions.
   - Sticky queue support with cache invalidation and eviction heuristics.
3. **Build-id routing**
   - Respect Temporal build IDs and `taskQueue` versioning, with CLI configuration.
4. **Graceful shutdown**
   - Drain in-flight work, respect `--graceful-shutdown-timeout`, expose `WorkerService` integrable with Effect layers.
5. **Observability**
   - Structured logs (JSON), metrics (poll latency, task failures), optional tracing.
6. **Query-only tasks (shipped)**
   - Detect `PollWorkflowTaskQueueResponse.query` and respond with `RespondQueryTaskCompleted` in a read-only executor mode (no new commands/timers/randomness/continue-as-new). Emits `temporal_worker_query_{started,completed,failed}_total` and `temporal_worker_query_latency_ms` metrics.

### Client Library

1. **Connect transport (shipped)**
   - gRPC-over-HTTP/2 with TLS/mTLS support, metadata canonicalisation.
2. **Resilience features (GA critical, TBS-005)**
   - Retry policies with jitter, idempotency keys, exponential backoff tuned to
     Temporal best practices.
   - Client interceptors for logging, auth, metrics.
3. **High-level APIs**
   - Convenience handles for workflow and activity results, typed search attributes,
     payload conversion hooks, streaming update support.
   - Query helpers honour `QueryRejectCondition` and surface query failures when workers respond via `RespondQueryTaskCompleted`.

### Tooling & Automation

- **CLI (TBS-007)**
  - Add `temporal-bun doctor` for connectivity validation.
  - Add `temporal-bun replay` for history replay against workflows.
  - Offer `--use-zig-bridge` toggle if native bridge returns.
- **Proto updates**
  - Scripted `buf` regeneration with Temporal release cadence tracking.
- **Release automation**
  - GitHub workflow for lint/test/build, version bump, changelog generation,
    signed npm publish, provenance attestations.

### Documentation & Developer Experience

- Architecture guides, quickstarts, troubleshooting covering determinism,
  payload converters, TLS, deployment recipes (Docker, serverless).
- API reference via `typedoc`.
- Migration path from the Rust/Zig bridge to pure TypeScript runtime.
- Example apps: update `packages/temporal-bun-sdk-example` to use deterministic
  context primitives (`activities.schedule`, `timers.start`, `determinism.now`).
  - Refresh `apps/docs/content/docs/temporal-bun-sdk.mdx` with: installation instructions, quickstart tutorials (worker + client), configuration guides, and release notes so new users can adopt the SDK confidently.
  - Introduce a multi-page docs hierarchy (e.g., Overview, Installation, Tutorials, Configuration, Troubleshooting, Release Notes) and wire it into the docs navigation so content scales beyond a single monolithic page.

## Error Handling & Observability

- Map Connect/gRPC status codes to Temporal-specific error classes.
- Provide structured error types for workflow failures (application, timeout,
  cancellation, deterministic).
- Integrate with Effect logging; expose `Logger` and `Metrics` interfaces for
  host applications.
- Plan for OpenTelemetry metrics (`temporal.worker.poll_time`, `workflow.task.latency`)
  and tracing instrumentation.
- Observability layers now back the worker/client runtimes; tracing hooks will piggyback on the same logger/metrics surfaces when ready.

## Configuration & Deployment

- `loadTemporalConfigEffect` (and the `TemporalConfigLayer`) already handle TLS, auth, task queue defaults, and worker identity configuration.
- GA tasks:
  - Support external config files (JSON/TOML) with schema validation.
  - Document environment variables for multi-namespace deployments.
  - Provide Dockerfile templates with best practices (non-root, minimal image).
  - Publish Helm/Knative snippets for worker deployment.
- Activity lifecycle knobs (`TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS`, `TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS`) now control heartbeat cadence and RPC timeouts; defaults keep cadence < heartbeat timeout.

## Testing & Quality Strategy

1. **Unit tests (shipped + expand)**
   - Maintain >90% coverage for command builders, determinism guard, config loader.
2. **Integration tests (GA critical)**
   - Automated Temporal dev-server suite covering:
     - Activity retries/heartbeats.
     - Timers and signals.
     - Child workflow failure propagation.
     - Continue-as-new determinism.
     - Build-id routing acceptance.
   - Each major functionality (TBS-001 ↔ TBS-007) must add integration tests using the Temporal CLI available in the execution environment, ensuring end-to-end validation is part of every deliverable.
   - `tests/integration/activity-lifecycle.integration.test.ts` exercises steady heartbeats, heartbeat timeout cancellation, and retry exhaustion with non-retryable errors via the CLI harness.
3. **Replay regression harness**
   - Capture real histories, replay offline, ensure deterministic snapshots survive
     worker restarts.
4. **Performance & soak testing**
   - Stress test worker concurrency scaling, measure poll latency under load.
5. **CI pipeline**
   - Bun tests, lint (Oxlint), formatting (`bunx oxfmt --check`), type-check (`bunx tsc --noEmit`), Temporal dev-server
     smoke test, Docker build verification.

## Documentation Plan

- **Docs map** – Maintain a single-source MDX page (`apps/docs/content/docs/temporal-bun-sdk.mdx`) until
  the docs nav exposes child routes. That page must always include: overview,
  architecture, configuration & operations, tutorials/recipes, CLI/tooling, and
  troubleshooting/GA roadmap sections. When nav support lands, split those
  sections into dedicated pages and link them from the overview.
- **Determinism & architecture deep dives** – Document determinism markers,
  sticky cache strategy, and Effect-based worker lifecycle (diagram + prose).
- **Cookbooks** – Provide runnable recipes for cron schedules, signal-with-start,
  updates, heartbeats, local activities, and replay debugging. Reference the
  example app for each recipe.
- **Migration guidance** – Call out differences between the historical Zig/Rust
  bridge and the Bun/Effect runtime, including how to port payload converters
  and TLS configuration.
- **CLI accessibility** – Audit output colors/ARIA hints for `temporal-bun`
  commands; ensure `doctor`/`replay` support `--json` for screen-reader/CI use.
- **Release notes & changelog hooks** – Mirror each release entry on the docs
  site (fed by release-please) with verification steps and upgrade notes now that
  TBS-009 is live.

## Release & Support Plan

1. **Versioning (TBS-009) – ✅ shipped**
   - Semantic versioning + release-please manifest drive RC/GA cadence.
2. **Changelog – ✅ automated**
   - release-please rewrites `CHANGELOG.md` from Conventional Commits.
3. **Publishing – ✅ trusted**
   - Signed npm publishes with provenance (GitHub OIDC trusted publishing).
4. **Support policy**
   - Document security disclosure process, escalation contacts, and SLA for bug fixes.

## Risks & Mitigations

| Risk                      | Impact                                 | Mitigation                                                                            |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------- |
| Determinism regressions   | Workflow non-determinism in production | Replay harness, sticky cache eviction tests, deterministic guard validations.         |
| Transport incompatibility | Bun HTTP/2 regressions                 | Continuous compatibility tests against Temporal Cloud and OSS releases.               |
| Performance under load    | Missed SLA on task latency             | Profiling with CPU/network throttling, concurrency tuning, metrics dashboards.        |
| Packaging regressions     | Broken ESM/CJS consumers               | Dual-package smoke tests (Bun, Node 20), tree-shaking tests, API lockfile.            |
| Tooling drift             | CLI/docs mismatched with runtime       | Doc-driven development checklist; docs PR cannot merge without updated CLI behaviour. |

## GA Checklist & Next Steps

1. ✅ Deterministic workflow context and command intents.
2. ✅ History replay ingestion, sticky cache, determinism persistence tests.
3. ✅ Activity lifecycle completeness (heartbeats, retries, failure categorisation).
4. ✅ Worker concurrency, sticky queues, graceful shutdown polish.
5. ✅ Client retries/interceptors, TLS hardening.
6. ✅ Observability: logs, metrics, tracing hooks.
7. ✅ Temporal dev-server integration suite + replay regression harness.
8. ✅ Documentation overhaul (architecture, tutorials, troubleshooting).
9. ✅ Release automation: lint/test/build, versioning, changelog, npm publish pipeline.
10. ✅ Support & maintenance guide (issue triage and security policy).

Progress through this checklist gates each release milestone (Alpha → Beta → RC → GA).
Every GA-critical item requires passing integration tests and updated documentation
before the release train can proceed.

## Post-GA Enhancements

1. **Unified observability surface.** After GA, ship optional Effect-based logger/metrics/tracing layers that can target OTLP, Prometheus remote write, or Bun-native sinks without introducing bridge processes. This includes turning the current console/in-memory stubs into documented extension points.
2. **Advanced scheduling experiments.** Explore adaptive concurrency and resource-based tuning (e.g., CPU/memory-aware queue depth, workflow/activities priority lanes) built directly on top of our Effect scheduler—no external “tuner” components required.
3. **Workflow packaging ergonomics.** Provide first-class support for both source-based workflows (ideal for Bun) and ahead-of-time bundles (for Docker/serverless), with deterministic dependency analysis and optional linting to catch non-deterministic imports.
4. **Client ecosystem integration.** Layer in retries/interceptors/TLS hardening plus ergonomic helpers (memo/search attribute schemas, schedule builders) so Bun clients reach feature parity with worker capabilities and promote end-to-end TypeScript-only deployments.
5. **Operational tooling.** Extend the CLI with “doctor”, “replay”, and “profile” commands that leverage the single-runtime architecture to run deterministic replays, capture telemetry snapshots, and surface build-id/namespace health without relying on external binaries.

## Worker versioning note

When `WorkerVersioningMode.VERSIONED` is enabled, the worker includes deployment metadata (deployment name + build ID) in poll/response requests so the server can route workflow tasks to the correct build. The Bun SDK does not call the deprecated Build ID Compatibility APIs (Version Set-based “worker versioning v0.1”), since they may be disabled on some namespaces.

Operationally, this means:

- Existing workflow runs will remain pinned to the build ID that last completed a workflow task.
- Deploying a new build ID will not cause nondeterministic replay on older runs, but those older runs will require that the old build remains available (or that the workflow code is backward-compatible via `determinism.getVersion` / `determinism.patched`).
