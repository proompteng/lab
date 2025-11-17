# Temporal Bun SDK – Production-Ready Design

_Last updated: November 17, 2025_

## Purpose
This document is the GA reference for `@proompteng/temporal-bun-sdk`. It explains what ships today, how the Bun-first architecture is assembled, which operational contracts keep workers healthy, and which enhancements remain on the roadmap. Use it alongside [`docs/release-runbook.md`](./release-runbook.md) when cutting releases and the refreshed README for developer-facing guidance.

## GA Capabilities
| Area | Status | Notes |
| --- | --- | --- |
| Workflow runtime | **GA** | Effect-powered workflow executor with deterministic guard, sticky determinism cache, replay markers, and `temporal-bun replay` tooling for diffing histories. |
| Worker runtime & CLI | **GA** | `temporal-bun-worker` orchestrates workflow/activity pollers, concurrency controls, and graceful drain/shutdown with worker versioning + build ID registration. |
| Temporal client | **GA** | Connect-powered `createTemporalClient()` supports TLS, retries, memo/search-attribute helpers, and Bun CLI automation for namespaces, workflows, and deployments. |
| Activities | **GA** | `ActivityContext` exposes heartbeat, cancellation, retry semantics, and telemetry hooks driven by Effect layers. |
| Observability & testing | **GA** | Integration harness bootstraps the Temporal CLI dev server, `temporal-bun replay` validates determinism, and the TBS-003 load suite exercises scheduler/poller health in CI. |
| Release workflow | **GA** | `.github/workflows/temporal-bun-sdk.yml` + release-please publish signed artifacts, while `packages/temporal-bun-sdk` emits Bun-native bundles ready for Docker/Knative deployment. |

## Post-GA Enhancements
| Work item | Issue | Notes |
| --- | --- | --- |
| Workflow Updates surface | #1814 | Adds `client.workflow.update()` helpers plus deterministic update handlers and scheduler plumbing; today users should continue relying on signals or idempotent workflow restarts. |
| Inbound signals & queries | #1815 | Brings typed handler registration, determinism ingestion, and replay metadata for inbound signal/query events. Currently only outbound signals are supported. |
| Query-only tasks | #1816 | Implements `RespondQueryTaskCompleted` so `client.queryWorkflow()` resolves without needing a workflow task. Pending to avoid mutating state during read-only executions. |
| Expanded workflow commands | #1817 | Rounds out cancellation scopes, search-attribute upserts, local activities, patches, `GetVersion`, and `SideEffect` to match the TypeScript SDK contract. |

## Shipped architecture
### Bun-first runtime
Everything (workflows, activities, client, CLI tooling) runs inside Bun ≥ 1.1.20. Generated Temporal protobuf stubs and Effect services replace the Node “core” bridge, so pollers, schedulers, sticky caches, and heartbeats all share the same event loop. This keeps deterministic decisions and telemetry consistent across the stack.

### Workflow runtime
`defineWorkflow()` handlers execute inside the Effect runtime. The executor records commands/timers/child workflows/signals plus logical time/entropy in a deterministic ledger. Snapshots are written as `temporal-bun-sdk/determinism` markers and cached per task queue (`TEMPORAL_STICKY_CACHE_SIZE`, `TEMPORAL_STICKY_TTL_MS`, `TEMPORAL_STICKY_SCHEDULING_ENABLED`). `temporal-bun replay` consumes captured histories (from the Temporal CLI or WorkflowService RPCs) to diff commands, emit structured mismatch logs, and unblock incident response.

### Worker orchestration & CLI
`temporal-bun-worker` and the Effect `WorkerService` layer start workflow/activity pollers, enforce concurrency budgets, and expose graceful drain hooks for deploys. Sticky queue management heals drift automatically and emits counters/logs for cache hits/misses. When worker versioning is enabled, the runtime registers build IDs before polling (configurable via `TEMPORAL_WORKER_BUILD_ID` / `TEMPORAL_WORKER_DEPLOYMENT_NAME`). The CLI also scaffolds new projects (`temporal-bun init`), wraps Docker image builds, and wires metrics exporters used by load tests.

### Temporal client & CLI integration
`createTemporalClient()` speaks gRPC over HTTP/2 via Connect, reuses the SDK’s `DataConverter`, and decorates every WorkflowService RPC with retries derived from `TEMPORAL_CLIENT_RETRY_*`. Optional `temporalCallOptions()` keep payloads distinct from call options. TLS helpers validate certificate bundles ahead of time and emit actionable `TemporalTlsConfigurationError` / `TemporalTlsHandshakeError` failures. CLI scripts in `scripts/start-temporal-cli.ts` and `scripts/stop-temporal-cli.ts` keep dev clusters aligned with production settings.

### Activities & reliability
Handlers run as plain async functions but receive `ActivityContext` through Effect scopes. Heartbeats respect `TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS` and `TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS`, storing the latest detail payload for cancellation/failure surfacing in Temporal UI. Retry policies mirror Temporal semantics (max attempts, interval backoff, non-retryable error types) and short-circuit when developers flag `error.nonRetryable = true`.

### Observability, replay & testing
The integration harness under `tests/integration/harness.ts` spins up the Temporal CLI dev server, executes workflows, and exports histories as JSON. `pnpm --filter @proompteng/temporal-bun-sdk exec bun run build` compiles distributable assets, while `pnpm --filter @proompteng/temporal-bun-sdk run test:load` exercises the TBS-003 load profile (mix of CPU and IO workflows with metrics captured to `.artifacts/worker-load/`). Replay fixtures under `tests/replay/fixtures/*.json` pin deterministic behaviour, and `temporal-bun replay` provides a CLI for live diffing (with `--source cli` or `--source service`).

### Release automation
Release-please manages version bumps via `.release-please-manifest.json` and `release-please-config.json`. The GitHub workflow `.github/workflows/temporal-bun-sdk.yml` builds Bun artifacts, runs validation, and publishes to npm once approvals land. Follow [`docs/release-runbook.md`](./release-runbook.md) to stage release notes, tag `v1.x.y`, push the package, and update operational runbooks; it also documents how to rebuild the Codex runner image when automation changes land.

## Support & operations
- **Environment dependencies:** Bun ≥ 1.1.20, Temporal CLI ≥ 1.4 (for the local harness), and access to Temporal Cloud or a matching self-hosted cluster. TLS/mTLS support requires `TEMPORAL_TLS_*` variables populated before workers or the CLI start.
- **Feature flags:** Sticky scheduling can be disabled via `TEMPORAL_STICKY_SCHEDULING_ENABLED=0` if namespaces lack sticky queue support. Worker versioning is optional but recommended; set `TEMPORAL_WORKER_VERSIONING_MODE` and monitor registration logs.
- **Release rigor:** Docs/livebooks (`README.md`, this file, CHANGELOG) are excluded from CI triggers, so run `pnpm --filter @proompteng/temporal-bun-sdk exec bun run build` plus `pnpm exec biome check packages/temporal-bun-sdk/README.md packages/temporal-bun-sdk/docs/production-design.md` locally before pushing.
- **Operational runbooks:** Use `temporal-bun replay` to triage determinism incidents, `bun scripts/start-temporal-cli.ts`/`stop-temporal-cli.ts` to sync dev servers, and reference `.github/workflows/temporal-bun-sdk.yml` when diagnosing release automation.

## Next steps
- Finish the Workflow Update API workstream (#1814) and document handler registration + CLI ergonomics in the README and this design doc.
- Land inbound signal/query ingestion plus deterministic snapshots (#1815), then add troubleshooting guidance for lost signals.
- Implement query-only task handling (#1816) so operators can rely on `client.queryWorkflow()` even when workflows are idle.
- Expand the workflow command surface per #1817 (cancellation scopes, search attribute upserts, local activities, `SideEffect`, `GetVersion`, patches) and update determinism guard docs accordingly.
- Layer on distributed tracing + docs automation in a follow-up run so releases capture observability regressions alongside semantic-version bumps.
