# Temporal Bun SDK – Production-Ready Design

## Goals

- Ship a Bun-first Temporal SDK that communicates with the Temporal service via Connect RPC, executes workflows entirely in TypeScript/Effect, and is published as a reliable npm package.
- Replace the legacy Zig/Rust bridge while delivering Temporal-grade workflow execution, activity handling, replay, and operational tooling.
- Provide a developer experience competitive with official Temporal SDKs: project scaffolding, schema-driven payloads, and clear documentation.

## Architecture Overview

- **Workflow Runtime (`src/workflow/*`)**
  - Workflow definitions, registry, executor. Needs replay engine, command builders, deterministic state machine for production.
- **Worker Runtime (`src/worker/*`)**
  - Long-poll loops, task execution, heartbeats, graceful shutdown, activity sandbox.
- **Client (`src/client.ts`)**
  - Temporal WorkflowService client built on Connect RPC; extend with retries, TLS, interceptors.
- **Example App (`packages/temporal-bun-sdk-example`)**
  - End-to-end validation of workflows and activities.
- **Protos (`proto/temporal/...`)**
  - Buf-generated message/service types; keep synced with upstream Temporal API.

Effect integration: workflows run inside the Effect runtime with schemas enforcing determinism. Activities and worker facilities are exposed as Effect services for ergonomic composition.

## Functional Requirements

| Capability | Work Required |
| --- | --- |
| Workflow command coverage | Implement scheduling commands (activities, timers, child workflows, signals, continue-as-new, failures/cancellations). Provide command factories with schema validation. |
| Replay & determinism | Build history processor to replay events, restore state, detect non-determinism. Maintain workflow cache keyed by workflow/run IDs. |
| Activity lifecycle | Emit `SCHEDULE_ACTIVITY_TASK`, manage retries/timeouts/heartbeats, support cancellation. |
| Worker loops | Concurrency controls, sticky task queues, build-id routing, error categorization/backoff. |
| Client features | Typed start/signal/query/cancel/update APIs, memo/headers/search attributes, interceptors. |
| Configuration | Expand `loadTemporalConfig` for TLS, auth, worker tuning. Support env + file overrides. |
| Diagnostics | Structured logging, metrics, tracing hooks; integrate with Effect logging. |
| Testing | Unit + integration suites (Temporal dev server), determinism regression tests. |
| Tooling | CLI scaffolding, replay tooling, typed doc generation. |
| Docs | Author architecture, usage guides, configuration references, migration paths. |

## Non-Functional Requirements

- **Performance**: Efficient polling, low-latency task handling, configurable concurrency.
- **Reliability**: gRPC error classification, retries with exponential backoff, resilient transport.
- **Determinism**: Guard against nondeterministic APIs; expose deterministic helpers (timers via Temporal).
- **Security**: TLS/mTLS, pluggable auth headers, secret handling conventions.
- **Packaging**: ESM + type declarations, minimal dependencies, Bun runtime clarified.

## Component Designs

### Workflow Runtime

- Extend `WorkflowDefinition` metadata (timeouts, task queues, version markers).
- Build workflow context API for deterministic commands (sleep, scheduleActivity, signal, continueAsNew).
- Executor pipeline: decode → replay → execute → emit commands.
- Replay engine: apply history events, compare against new commands, raise non-determinism errors.

### Activity Execution

- Activity definitions with schemas, registry similar to workflows.
- Wrap handlers with timeout/cancellation logic leveraging `ActivityContext`.
- Implement heartbeat APIs and retry policies.

### Worker Runtime

- Introduce configurable worker pools (workflow and activity processors).
- Add sticky queues and workflow cache eviction policies.
- Implement structured logging, metrics, and categorized retries.
- Provide graceful shutdown with in-flight task draining and forced timeout.

### Client Library

- High-level typed workflow handle APIs (`start`, `signal`, `query`, `cancel`, `update`).
- Pluggable data converters (JSON default, allow Proto/binary).
- Retry/interceptor framework for auth, logging, metrics.

### CLI & Tooling

- `temporal-bun init` scaffolds workflows, activities, config, scripts.
- Additional commands: project linting, proto regeneration, history replay.

### Payload Handling

- Extend converters to support payload metadata, binary encodings, schema-based serialization.
- Expose hooks for custom converters per namespace/task queue.

## Error Handling Strategy

- Map gRPC codes to retry/fail-fast categories.
- Emit structured Effect logs and metrics around poll failures, task results, workflow non-determinism.
- Fail workflow tasks with `WorkflowTaskFailedCause.NON_DETERMINISTIC_ERROR` when mismatches occur.

## Configuration & Deployment

- Environment variables for address, namespace, task queue, TLS, credentials, worker tuning.
- Optional config files (JSON/TOML) merged with env.
- Document Docker/serverless deployment patterns.

## Testing Strategy

- **Unit**: command builders, replay engine, activity context, client serialization.
- **Integration**: run against Temporal dev server; scenarios for timers, retries, cancellations, signals, child workflows.
- **CI**: Biome linting, Bun tests, Temporal dev server smoke test, TypeScript build.

## Documentation Plan

- Revive `/docs` with architecture overview, workflow guide, activity guide, client usage, config reference, troubleshooting, migration guide.
- Generate API reference (typedoc) and publish developer FAQ.

## Release Plan

1. **Alpha** – core command coverage, basic replay, activities.
2. **Beta** – determinism checks, advanced commands (signals/child workflows), client parity, logging/metrics.
3. **RC** – polish error handling, telemetry, performance tuning, docs freeze.
4. **GA** – semantic versioning, changelog, support policy.

## Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Determinism bugs | Enforce deterministic API usage, provide lint rules/documentation, extensive replay tests. |
| Transport edge cases | Regularly sync protos, run compatibility tests against Temporal releases. |
| Bun-specific APIs limit adoption | Document runtime requirements; evaluate Node-compatible build. |
| Replay engine complexity | Build incrementally, port patterns from official SDKs, invest in integration tests. |
| Packaging regressions | Add bundler/tree-shaking tests, keep dependency footprint minimal. |

## Next Steps

1. ✅ Implement workflow command builders and context API (Effect-based context, command intents, determinism guardrails).
2. Build history replay engine with determinism checks.
3. Add activity scheduling/heartbeat/cancellation support.
4. Introduce worker concurrency controls and sticky queue handling.
5. Expand client API with retries/interceptors and typed payloads.
6. Integrate structured logging/metrics.
7. Establish integration test harness and CI pipeline.
8. Rebuild documentation + CLI scaffolding to match the new runtime.
9. Set up release automation (versioning, changelog, npm publish).

Delivering these workstreams will take the current prototype to a production-ready Temporal Bun SDK suitable for npm publication.
