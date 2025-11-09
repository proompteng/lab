# Temporal Bun SDK – Production-Ready Design

_Last updated: November 6, 2025_

## Purpose

This document is the single source of truth for taking `@proompteng/temporal-bun-sdk`
to a generally available release on npm that can be trusted by millions of
Temporal developers. It records what already ships in `main`, what gaps remain,
and the quality bars we must meet before GA.

## Current State Snapshot

| Area | Status | Notes |
| --- | --- | --- |
| Workflow execution | **Alpha** | Deterministic command context, activity/timer/child/signal/continue-as-new intents, deterministic guard. |
| Worker runtime | **Beta-** | Effect-based scheduler with configurable concurrency, sticky cache routing, and build-id metadata. Heartbeats and observability still pending. |
| Client | **Alpha** | Start/signal/query/cancel/update/describe namespace with Connect transport; interceptors and retries pending. |
| Activities | **Beta-** | Handler registry, cancellation signals. Heartbeats, retries, and failure categorisation remain. |
| Tooling & docs | **Pre-Alpha** | CLI scaffolds projects and Docker image. Developer docs partially updated for deterministic context. |
| Testing | **Pre-Alpha** | Unit coverage for executor intents. No Temporal dev-server integration suite or determinism regression harness. |

> **Release target:** GA requires all sections below marked as **Critical for GA**
to be complete, with supporting validation and documentation.

## Architecture Overview

- **Workflow Runtime (`src/workflow/*`)**
  - _Shipped:_ Deterministic workflow context, command intents, determinism guard.
  - _GA requirements:_ History replay ingest, failure categorisation, command metadata (headers/memo/search attributes), workflow cache eviction strategy.
- **Worker Runtime (`src/worker/*`)**
  - _Shipped:_ Single-threaded pollers, deterministic snapshot persistence per run.
  - _GA requirements:_ Configurable concurrency, sticky task queues, build-id routing, graceful shutdown with drain, heartbeat plumbing, metrics/logging hooks.
- **Client (`src/client.ts`)**
  - _Shipped:_ Connect WorkflowService client with payload conversion and header normalisation.
  - _GA requirements:_ Retry/interceptor framework, TLS/auth hardening, memo/search attribute helpers, long-running operation ergonomics.
- **Activities (`src/activities/*`, `src/worker/activity-context.ts`)**
  - _Shipped:_ AsyncLocalStorage-based context, cancellation surface.
  - _GA requirements:_ Heartbeat API, retry policy adherence, progress payload encoding, failure classification.
- **Tooling**
  - CLI (`src/bin/temporal-bun.ts`) scaffolds projects; needs connectivity checks, history replay tooling, lint hooks.
- **Generated Protos (`src/proto/**`)**
  - Must stay synced with upstream Temporal releases; add automation for updates.

## Functional Roadmap

| Capability | Status | Acceptance Criteria | GA Critical? |
| --- | --- | --- | --- |
| Command coverage | ✅ context + intents | Activities, timers, child workflows, signals, continue-as-new emit correct commands with metadata and retries. | Yes |
| History replay | 🚧 in design | Worker hydrates history into determinism state, verifies commands, tolerates sticky cache eviction, exposes replay API. | Yes |
| Activity lifecycle | 🚧 partial | Heartbeats, retries, cancellation reasons, eager activities. | Yes |
| Worker concurrency | ✅ scheduler + sticky queues | Configurable parallelism, sticky queues, build-id routing, per-namespace/task queue isolation. | Yes |
| Client resilience | 🚧 partial | Retry policies, interceptors, TLS/mTLS test matrix, structured errors. | Yes |
| Diagnostics | 🚧 not started | Structured logs, OpenTelemetry metrics/traces, hookable logger. | Yes |
| Testing & QA | 🚧 partial | Deterministic regression suite, integration tests with Temporal dev server, load/perf smoke tests. | Yes |
| Tooling | 🚧 partial | CLI connectivity check, replay CLI, proto regeneration script, API docs generator. | No (Beta) |
| Documentation | 🚧 partial | Architecture guide, workflow/activities best practices, migration guide, troubleshooting, accessibility for CLI. | Yes |
| Release operations | 🚧 not started | Semantic versioning, changelog automation, npm publish pipeline, support SLAs. | Yes |

Legend: ✅ complete, 🚧 in progress/planned.

## Work Breakdown & TODO Map

Each deliverable is tracked with a `TBS-xxx` identifier. New scaffolding and TODO
comments in the repository reference these IDs so multiple Codex runs can execute
in parallel without collisions.

| ID | Epic | Description | Primary Modules |
| --- | --- | --- | --- |
| **TBS-001** | History Replay | Build history ingestion, determinism snapshot persistence, mismatch diagnostics. | `src/workflow/replay.ts`, `src/worker/sticky-cache.ts`, `src/worker/runtime.ts` |
| **TBS-002** | Activity Lifecycle (✅) | Heartbeat helper wired to WorkflowService with retry/cancellation, local retry orchestration, enriched cancellation metadata. | `src/activities/lifecycle.ts`, `src/worker/activity-runtime.ts` |
| **TBS-003** | Worker Concurrency | Add scheduler for concurrent workflow/activity processors, sticky queues, build-id routing. | `src/worker/concurrency.ts`, `src/worker/runtime.ts` |
| **TBS-004** | Observability | Emit structured logs, metrics, and tracing hooks across client/worker. | `src/observability/logger.ts`, `src/observability/metrics.ts` |
| **TBS-005** | Client Resilience | Layered retries, interceptors, TLS/auth validation, memo/search helpers. | `src/client/interceptors.ts`, `src/client/retries.ts` |
| **TBS-006** | Integration Harness | Temporal dev-server automation, replay regression suite, load tests. | `tests/integration/harness.ts`, `tests/replay/*.ts` |
| **TBS-007** | CLI Tooling | `temporal-bun doctor`, `temporal-bun replay`, proto regeneration script. | `src/bin/temporal-bun.ts`, `scripts/proto/update-temporal-protos.ts` |
| **TBS-008** | Documentation & DX | Architecture guide, cookbook, migration path, CLI accessibility. | `apps/docs/content/docs/temporal-bun-sdk.mdx`, `docs/*` |
| **TBS-009** | Release Automation | CI workflows, changelog, signed publish, support policy artifacts. | `.github/workflows/release-temporal-bun-sdk.yml`, `docs/release-runbook.md` |
| **TBS-010** | Effect Architecture | Migrate worker/client/config/runtime to Effect Layers, structured dependency injection, and fiber supervision. | `src/runtime/effect-layers.ts`, `src/worker/runtime.ts`, `src/client.ts`, `src/config.ts` |

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

### TBS-010 – Effect Architecture

- `src/runtime/effect-layers.ts` now exposes `BaseRuntimeLayer`, `makeWorkerLayer`, and
  the `WorkerRuntimeService` tag so worker runtime, CLI, and tooling can share managed
  config/logger/metrics/workflow service/sticky cache/scheduler resources.
- `src/worker/runtime.ts` runs entirely inside scoped `Effect` programs—pollers,
  scheduler lifecycle, and sticky cache access are fiber-driven, enabling graceful
  interruption from CLI signal handlers instead of `AbortController`s.
- `src/worker.ts` bootstraps through the new layers while preserving the legacy
  `createWorker` surface area by wrapping a managed runtime composed from
  `BaseRuntimeLayer` and `makeWorkerLayer`.
- `src/client.ts` accepts an injected `workflowService` so layer consumers can reuse
  the shared WorkflowService transport when composing CLIs or tests.
- TODO: propagate the same layering contract to CLI commands, activity runtimes,
  and the integration harness so every entry point is Effect-first.

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

### TBS-001 – History Replay & Sticky Cache

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
  4. Unit tests and dev-server scenario verifying behaviour.
- **Implementation notes**
  - Determinism snapshots are persisted as `temporal-bun-sdk/determinism` record markers (schema v1) that bundle command history, random/time streams, and the last processed event id. The marker payload is stored via the configured `DataConverter`.
  - `TEMPORAL_STICKY_CACHE_SIZE` and `TEMPORAL_STICKY_TTL_MS` control cache capacity and eviction; the sticky worker queue schedule-to-start timeout inherits from the TTL so increasing it lengthens deterministic affinity.
  - `tests/integration/harness.ts` provides a Temporal CLI-backed harness that starts the dev server, executes workflows (`temporal workflow execute`), fetches JSON history (`temporal workflow show --output json`), and feeds the ingestion pipeline. Tests log a skip when the CLI is unavailable instead of failing hard.
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
  3. ✅ Build-id routing respected when scheduling tasks (`TEMPORAL_WORKER_DEPLOYMENT_NAME`, `TEMPORAL_WORKER_BUILD_ID`).
  4. ✅ Graceful shutdown drains tasks; metrics/log hooks tracked under TBS-004.
  5. 🚧 Load tests demonstrate throughput improvements.
- **Dependencies**
  - Consumes determinism cache (TBS-001), emits metrics for TBS-004.

### TBS-004 – Observability

- **Starting points**
  - `src/observability/logger.ts`, `src/observability/metrics.ts` – replace console/in-memory stubs.
  - Thread logger/metrics dependencies through worker and client constructors.
- **Effect guidance**
  - Provide Layers (`Effect.Layer`) for injecting logger/metrics (coordinate with TBS-010).
  - Use structured logging JSON, integrate with OpenTelemetry API.
- **Acceptance criteria**
  1. Configurable logger exposing debug/info/warn/error with context.
  2. Metrics registry exporting poll latency, command counts, retry attempts.
  3. Optional tracing instrumentation toggled via config.
  4. Documentation explaining how to plug custom sinks.

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
  2. `temporal-bun replay` replays a supplied history file via TBS-001 ingestion.
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

### TBS-009 – Release Automation

- **Starting points**
  - `.github/workflows/release-temporal-bun-sdk.yml` (to be created).
  - `docs/release-runbook.md` – fill out procedures.
- **Acceptance criteria**
  1. CI pipeline covering lint/type/test/integration/build.
  2. Automated semantic version bump + changelog.
  3. Signed npm publish (provenance).
  4. Support policy and security contact doc published.

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
- TODO(TBS-004): Wire `observability/logger.ts` and `observability/metrics.ts`
  into worker/client pipelines with hooks for custom sinks.

## Configuration & Deployment

- `loadTemporalConfig` already handles TLS, auth, task queue defaults, and worker identity configuration.
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
   - Bun tests, lint (Biome), type-check (`bunx tsc --noEmit`), Temporal dev-server
     smoke test, Docker build verification.

## Documentation Plan

- Update developer docs with deterministic context primitives and migration guides.
- Provide cookbook recipes (cron workflows, signal-with-start, updates, activity
  heartbeat best practices).
- Accessibility review for CLI output (color contrast, terminal semantics).
- Generate versioned docs site; keep changelog linked per release.

## Release & Support Plan

1. **Versioning (TBS-009)**
   - Semantic versioning, release candidates before GA.
2. **Changelog**
   - Automated changelog (Conventional Commits).
3. **Publishing**
   - Signed npm publishes with provenance (GitHub OIDC + npm token scoping).
4. **Support policy**
   - Define Node/Bun versions supported, Temporal server version compatibility.
   - Document security disclosure process and SLA for bug fixes.

## Risks & Mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Determinism regressions | Workflow non-determinism in production | Replay harness, sticky cache eviction tests, deterministic guard validations. |
| Transport incompatibility | Bun HTTP/2 regressions | Continuous compatibility tests against Temporal Cloud and OSS releases. |
| Performance under load | Missed SLA on task latency | Profiling with CPU/network throttling, concurrency tuning, metrics dashboards. |
| Packaging regressions | Broken ESM/CJS consumers | Dual-package smoke tests (Bun, Node 20), tree-shaking tests, API lockfile. |
| Tooling drift | CLI/docs mismatched with runtime | Doc-driven development checklist; docs PR cannot merge without updated CLI behaviour. |

## GA Checklist & Next Steps

1. ✅ Deterministic workflow context and command intents.
2. 🚧 History replay ingestion, sticky cache, determinism persistence tests.
3. ✅ Activity lifecycle completeness (heartbeats, retries, failure categorisation).
4. 🚧 Worker concurrency, sticky queues, graceful shutdown polish.
5. 🚧 Client retries/interceptors, TLS hardening.
6. 🚧 Observability: logs, metrics, tracing hooks.
7. 🚧 Temporal dev-server integration suite + replay regression harness.
8. 🚧 Documentation overhaul (architecture, tutorials, troubleshooting).
9. 🚧 Release automation: lint/test/build, versioning, changelog, npm publish pipeline.
10. 🚧 Support & maintenance guide (compatibility matrix, issue triage, security policy).

Progress through this checklist gates each release milestone (Alpha → Beta → RC → GA).
Every GA-critical item requires passing integration tests and updated documentation
before the release train can proceed.
