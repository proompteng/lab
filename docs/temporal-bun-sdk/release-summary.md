# Release-ready summary (Temporal Bun SDK)

This summary captures the production-ready feature set delivered by the
Temporal Bun SDK design-doc initiative. It is intended for release notes,
operational handoff, and migration planning.

## Highlights

- Test workflow environments (local, time-skipping, existing server).
- Schedule client + typed search attributes (Effect Schema validation).
- Nexus workflow operations with structured errors and observability hooks.
- Worker ops, versioning rules, task queue config, and deployment APIs.
- Replay CLI with determinism diffs, JSON reports, and Bun inspector support.
- Observability stack (logging/metrics/tracing) plus plugin + tuner architecture.
- Full WorkflowService, OperatorService, and CloudService RPC coverage.

## Migration notes

- **Backward compatible by default.** Existing workflows and workers continue to
  run without code changes; new surfaces are additive.
- **Opt-in behavior.** Advanced runtime capabilities (tuning, plugins, OTEL,
  time-skipping) are disabled unless explicitly enabled.
- **Dev server limitations.** The Temporal CLI dev server may not support
  worker-versioning and some worker-ops RPCs; the SDK logs warnings and continues.
- **Determinism markers.** Determinism snapshots remain stored as
  `temporal-bun-sdk/determinism` markers. You may tune marker behavior via
  `TEMPORAL_DETERMINISM_MARKER_*` without breaking existing histories.

## Feature flags and opt-in switches

These controls allow staged rollout and safe experimentation:

- **Testing environment**
  - `TEMPORAL_CLI_PATH`, `TEMPORAL_PORT`, `TEMPORAL_UI_PORT`,
    `TEMPORAL_TIME_SKIPPING=1` (CLI dev server behavior).
- **Observability**
  - `TEMPORAL_LOG_FORMAT`, `TEMPORAL_LOG_LEVEL` (structured logging).
  - `TEMPORAL_METRICS_EXPORTER`, `TEMPORAL_METRICS_ENDPOINT` (metrics sinks).
  - `TEMPORAL_TRACING_INTERCEPTORS_ENABLED=false` to disable tracing interceptors.
  - `TEMPORAL_OTEL_ENABLED=true` and `TEMPORAL_OTEL_AUTO_INSTRUMENTATION=true`
    to start the OpenTelemetry SDK and auto-instrumentation.
- **Determinism tuning**
  - `TEMPORAL_DETERMINISM_MARKER_MODE`, `TEMPORAL_DETERMINISM_MARKER_INTERVAL_TASKS`,
    `TEMPORAL_DETERMINISM_MARKER_FULL_SNAPSHOT_INTERVAL_TASKS`,
    `TEMPORAL_DETERMINISM_MARKER_SKIP_UNCHANGED`, `TEMPORAL_DETERMINISM_MARKER_MAX_DETAIL_BYTES`.
- **Runtime controls (code-level)**
  - `WorkerRuntimeOptions.plugins` for worker plugins.
  - `WorkerRuntimeOptions.tuner` (or `createStaticWorkerTuner`) for dynamic concurrency.
  - `WorkerRuntimeOptions.deployment` to enable worker versioning and deployments.

## Operational guidance

- **Testing envs**: Prefer `TestWorkflowEnvironment.createLocal()` for unit tests
  and `createTimeSkipping()` for deterministic timer-heavy tests.
- **Schedules**: Use `client.schedules.*` for schedule lifecycle, and use
  `client.searchAttributes.typed()` to enforce schema validation in workflows.
- **Nexus**: Use `ctx.nexus.schedule()` and `ctx.nexus.cancel()` within workflows.
  The SDK injects `x-temporal-bun-operation-id` headers for deterministic replay.
- **Worker ops & deployments**: Use `client.workerOps.*` and `client.deployments.*`
  in ops tooling. Handle `Unimplemented` gracefully when hitting older servers.
- **Replay/debug**: `bunx temporal-bun replay --json` produces a machine-readable
  report; `--debug` + `bun --inspect-brk` enables step-through debugging.
- **Observability**: The `temporal-bun doctor` CLI validates config, emits logs,
  and flushes metrics to verify sinks before production rollout.

## RPC coverage confirmation

All WorkflowService, OperatorService, and CloudService RPCs are exposed through
high-level namespaces (`client.schedules`, `client.workerOps`, `client.operator`,
`client.cloud`) or the low-level `client.rpc.*.call()` helpers with full
`TemporalClientCallOptions` support (headers, timeout, retry overrides, abort).

## Upstream alignment (reviewed 2026-01-16)

- `temporalio/sdk-core` @ `148774c04cdfec54cea8ddd5673ecb508e05bdd9` (2025-08-15)
- `temporalio/sdk-typescript` @ `2fbcbe75599ebc3780520e0d73c0a8d496c2ae88` (2025-12-17)
