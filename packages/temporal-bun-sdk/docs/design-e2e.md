# Temporal Bun SDK — End-to-End Design

**Author:** Platform Runtime Team  
**Original Publish Date:** 17 Oct 2025  
**Last Updated:** 1 Nov 2025  
**Status:** In progress

---

## 1. Product Goals & Target Experience

Deliver `@proompteng/temporal-bun-sdk`, a Bun-first Temporal SDK that teams can install from npm, configure in minutes, and trust for production-grade workflow execution. The experience should mirror Temporal's official TypeScript SDK while leaning on Bun for fast startup and a compact distribution footprint.

### Supported Platforms & Scenarios

- **Runtime Targets:** Bun ≥ 1.1.20 running on macOS and Linux (x86_64/arm64). Windows remains out of scope for v0.1.x while Zig bridge artifacts are macOS/Linux only.
- **Temporal Deployments:** Local Docker Compose clusters, Kubernetes-hosted Temporal, and Temporal Cloud. Temporal Cloud requires mTLS & API key metadata consistent with [Temporal Cloud certificates](https://docs.temporal.io/cloud/certificates) and [API key best practices](https://docs.temporal.io/cloud/api-keys).
- **Developer Workflow:**
  - `pnpm install @proompteng/temporal-bun-sdk` succeeds without additional toolchains; native bits ship prebuilt.
  - `createTemporalClient()` yields a Bun-native client backed by the Zig bridge.
  - `temporal-bun init` scaffolds a worker project; `temporal-bun check` validates connectivity.
  - Documentation covers local dev, Temporal Cloud setup, and troubleshooting.

## 2. Implementation Snapshot (25 Oct 2025)

### TypeScript layer
- ✅ `createTemporalClient` loads the Zig bridge through `bun:ffi`, applies TLS/API key metadata, and exposes workflow helpers (see `src/client.ts`).
- ✅ CLI commands (`temporal-bun init|check|docker-build`) ship in `src/bin/temporal-bun.ts`.
- ✅ Worker bootstrap (`createWorker`, `runWorker`) defaults to the Bun-native runtime backed by the Zig bridge, with an opt-in `TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1` escape hatch to reuse `@temporalio/worker` when needed.
- ✅ `client.workflow.cancel` encodes RequestCancelWorkflowExecution payloads and resolves Zig pending handles through Temporal core; `client.workflow.signal` continues to route through core with deterministic request IDs plus client identity.
- ✅ `client.updateHeaders` hot-swaps metadata via the Zig bridge and returns Temporal core status codes without forcing a reconnect.
- ✅ `WorkerRuntime` and the `WorkflowEngine` execute workflow activations inside Bun, emitting `WorkflowActivationCompletion` payloads through the Zig bridge. Activity polling, cancellation, and heartbeats are implemented; worker telemetry hooks remain TODO.
- ✅ `loadTemporalConfig` now surfaces `TEMPORAL_SHOW_STACK_SOURCES`, letting operators opt into inline workflow stack traces.

### Zig native bridge (`packages/temporal-bun-sdk/bruke`)
- ✅ Uses `@cImport("temporal-sdk-core-c-bridge.h")` to call Temporal core runtime/client APIs.
- ✅ Implements async pending handles for client connect, DescribeNamespace, workflow queries, and workflow signals via dedicated worker threads.
- ✅ Encodes workflow start and signal-with-start requests directly in Zig, returning JSON metadata to Bun.
- ✅ `core.signalWorkflow` now builds `SignalWorkflowExecutionRequest`, forwards gRPC statuses, and acknowledges pending handles with Temporal core responses.
- ✅ `temporal_bun_client_cancel_workflow` forwards cancellation payloads to Temporal core using `client_rpc_call`, returning structured errors via pending handles.
- ✅ Worker exports (`temporal_bun_worker_*`) now poll workflow and activity tasks, record heartbeats, and complete/cancel activity executions. Open work focuses on telemetry and graceful drain behaviour.
- ✅ Telemetry configuration (`temporal_bun_runtime_update_telemetry`) applies Prometheus and OTLP exporters; ✅ logger installation (`temporal_bun_runtime_set_logger`) now forwards Temporal core logs into Bun callbacks.
- ✅ Byte-array allocations now emit Prometheus/OTLP counters and enforce double-free guardrails via the Zig bridge (`zig-buf-02`), with Bun helpers exposing snapshots for tests.

### Tooling & Distribution
- ✅ `scripts/download-temporal-libs.ts` downloads pinned Temporal core static libs, enabling reproducible Zig builds.
- ✅ `pnpm run build:native:zig` compiles `libtemporal_bun_bridge_zig` for macOS/Linux and `package:native:zig` stages artifacts under `dist/native/<platform>/<arch>/` (source in `bruke/`).
- ✅ `prepack` hook builds TypeScript, fetches native libs, compiles Zig, and packages artifacts automatically.
- ✅ `tests/native.integration.test.ts`, `tests/end-to-end-workflow.test.ts`, and `tests/zig-signal.test.ts` exercise the bridge against the Temporal CLI dev server.
- ✅ `tests/worker.runtime.workflow.test.ts`, `tests/worker/worker-runtime-*.test.ts`, and `tests/worker/zig-poll-workflow.test.ts` cover workflow and activity loops via the Bun runtime.
- ⚠️ `zig build test` executes stubbed unit tests only; coverage for worker telemetry remains TODO.

## 3. Architecture Overview

```
┌──────────────────────────────────────────┐
│ @proompteng/temporal-bun-sdk (TypeScript)│
│  ├─ Config & client helpers              │
│  ├─ Worker (Bun runtime + WorkflowEngine)│
│  └─ CLI / scaffolding                    │
└──────────────────────┬───────────────────┘
                      │ bun:ffi
┌─────────────────────▼────────────────────┐
│ libtemporal_bun_bridge_zig.dylib/.so     │
│  ├─ Pending-handle runtime               │
│  ├─ Temporal RPC encoding                │
│  └─ Worker stubs (future work)           │
└─────────────────────┬────────────────────┘
                      │ C ABI
┌─────────────────────▼────────────────────┐
│ temporal-sdk-core-c-bridge (Rust)        │
│  └─ Temporal core runtime & gRPC client  │
└─────────────────────┬────────────────────┘
                      │ gRPC
              Temporal Server / Cloud
```

Key properties:
- All Temporal interactions flow through Zig → Temporal core; Node SDK usage is confined to the worker fallback.
- Pending handles allow Bun to poll async results without blocking its event loop.
- Zig bridge enforces strict JSON validation before making core RPCs, surfacing structured Temporal gRPC status codes to Bun.
- Client-facing Zig code is split into modules under `bruke/src/client/` (`common.zig`, `connect.zig`, `workflows/*`, etc.) with a lightweight aggregator `client/mod.zig`, letting teams evolve features in parallel without editing a monolith.

## 4. Native Bridge Function Matrix

| Area | Export | Status | Notes |
|------|--------|--------|-------|
| Runtime | `temporal_bun_runtime_new` / `free` | ✅ | Creates Temporal core runtime and tracks pending connects with thread-safe counters. |
| Runtime | `temporal_bun_runtime_update_telemetry` | ✅ | Applies Prometheus/OTLP telemetry configuration and propagates Temporal core errors. |
| Runtime | `temporal_bun_runtime_set_logger` | ✅ | Registers Bun callbacks and forwards Temporal core logs via the Zig bridge. |
| Client | `temporal_bun_client_connect_async` | ✅ | Async connect with pending handle + thread pool. |
| Client | `temporal_bun_client_describe_namespace_async` | ✅ | Encodes protobuf request and resolves via pending handle. |
| Client | `temporal_bun_client_start_workflow` | ✅ | Encodes workflow start protobufs, returns JSON metadata. |
| Client | `temporal_bun_client_signal_with_start` | ✅ | Shares start encoder, invokes `SignalWithStartWorkflowExecution`. |
| Client | `temporal_bun_client_query_workflow` | ✅ | Spawns worker thread, decodes `QueryWorkflowResponse`, maps errors. |
| Client | `temporal_bun_client_signal` | ✅ Complete | Encodes `SignalWorkflowExecutionRequest` with identity/request IDs and surfaces Temporal core statuses via Zig bridge (`zig-wf-05`). |
| Client | `temporal_bun_client_terminate_workflow` | ✅ | Executes Temporal core termination RPC and propagates gRPC status codes. |
| Client | `temporal_bun_client_cancel_workflow` | ✅ Implemented | Routes RequestCancelWorkflowExecution via `client_rpc_call`. |
| Client | `temporal_bun_client_update_headers` | ✅ | Accepts JSON metadata, normalizes headers, and forwards updates to Temporal core. |
| Worker | `temporal_bun_worker_*` | ❌ Not implemented | Creation, poll, heartbeat, and shutdown functions are placeholders. |
| Byte transport | Pending + byte array helpers | ✅ | Shared across client RPCs; ensures buffers freed via Temporal core callbacks. |

## 5. TypeScript & CLI Surface

- `src/client.ts` exposes:
  - Bun-native client creation with TLS/API key handling via `loadTemporalConfig`.
  - Workflow helpers (`start`, `signalWithStart`, `query`, `terminate`, `cancel`, `signal`). Methods backed by Zig exports propagate structured `NativeBridgeError`s when unimplemented paths are invoked.
  - JSON schema validation through `zod` before crossing the FFI boundary.
- `src/config.ts` parses environment variables, automatically base64-encoding TLS certificates for Temporal Cloud.
- `src/worker.ts` keeps the Node worker runtime in place so teams can run workflows while the Bun worker bridge is unfinished; swapping to `WorkerRuntime` will be tracked once Zig worker exports land.
- CLI (`src/bin/temporal-bun.ts`):
  - `temporal-bun init <dir>` scaffolds a Bun Temporal worker project.
  - `temporal-bun check [--namespace <ns>]` uses the Zig bridge to run `DescribeNamespace`.
  - `temporal-bun docker-build` generates a Docker image skeleton.

## 6. Build & Distribution

- `pnpm --filter @proompteng/temporal-bun-sdk run build` builds TypeScript to `dist/`.
- `pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig` compiles the Zig bridge in `ReleaseFast` mode; artifacts land under `bruke/zig-out/lib/<platform>/<arch>/`.
- `pnpm --filter @proompteng/temporal-bun-sdk run package:native:zig` copies shared libraries into `dist/native/...` so `pnpm pack` includes them.
- `scripts/download-temporal-libs.ts` fetches pinned Temporal core archives (commit `de674173c664d42f85d0dee1ff3b2ac47e36d545`, sdk-typescript `v1.13.1`).
- `bun test` executes Bun unit/integration tests; `zig build test` (debug) validates pending-handle logic.
- CI expectations: lint (Biome), type-check (tsc), Zig release build, Bun tests, optional Zig tests.

## 7. Temporal Cloud Support

- `loadTemporalConfig` reads:
  - `TEMPORAL_TLS_CA_PATH`, `TEMPORAL_TLS_CERT_PATH`, `TEMPORAL_TLS_KEY_PATH`, `TEMPORAL_TLS_SERVER_NAME` and loads file contents as Buffers.
  - `TEMPORAL_API_KEY` and injects API key metadata.
  - `TEMPORAL_ALLOW_INSECURE` toggles TLS verification (mirrors existing Go worker behavior).
- `serializeTlsConfig` (CLI + client) base64-encodes cert/key pairs before handing them to the Zig bridge, matching Temporal core expectations.
- Docs include `.env.example` guidance and link to Temporal Cloud setup references.
- Follow-up: validate metadata update behaviour against a live Temporal server and extend CLI docs with cancellation walkthroughs.

## 8. Testing & Validation

- Bun tests:
- `tests/native.integration.test.ts` spins up the Temporal CLI dev server and exercises workflow start/query/cancel via the Zig bridge.
  - `tests/end-to-end-workflow.test.ts` validates sample workflow execution.
  - `tests/worker.runtime.workflow.test.ts`, `tests/worker/worker-runtime-activity.test.ts`, `tests/worker/worker-runtime-shutdown.test.ts`, and `tests/worker/zig-poll-workflow.test.ts` cover workflow activations, activity lifecycles, and shutdown semantics when `TEMPORAL_BUN_SDK_USE_ZIG=1`.
  - `tests/zig-signal.test.ts` exercises signal delivery end-to-end against the Temporal CLI dev server when available.
  - `tests/client.test.ts` mocks the native module to verify payload encoding and validation logic.
- Zig tests:
  - `zig build test` covers JSON validation helpers and pending-handle state machines.
  - Worker completion tests assert callback plumbing in `worker.zig`; polling is now exercised via Bun tests.
- Manual QA: `pnpm --filter @proompteng/temporal-bun-sdk run temporal:start` launches a local server; `TEMPORAL_BUN_SDK_USE_ZIG=1 bun test tests/native.integration.test.ts` performs smoke validation (start/query/cancel); enable `TEMPORAL_SHOW_STACK_SOURCES=1` to inspect stack trace sources.

## 9. Remaining Work & Milestones

The detailed lane breakdown lives in [`docs/parallel-implementation-plan.md`](./parallel-implementation-plan.md). Each item below
maps to one or more lanes so parallel Codex instances can implement features without clobbering each other.

1. **Client parity**
   - Add automated Temporal Cloud/Compose coverage so cancellation tests run with a live server in CI.
2. **Runtime telemetry & logging**
   - Expand automated coverage for Prometheus and OTLP exporters (native + Bun tests) and capture regression fixtures.
   - Document operational playbooks for telemetry dashboards and emitted metrics fields.
3. **Worker bridge**
   - Add activity metrics support in Zig and surface telemetry for shutdown timing (follow-up after `zig-worker-09`).
   - Harden Bun `WorkerRuntime` parity (activity interception, metrics, diagnostics) and document the vendor fallback toggle.
4. **Developer experience**
   - Expand CLI (`temporal-bun init`) templates with Zig bridge usage instructions.
   - Provide `demo:e2e` script referenced in the doc (currently a follow-up).
5. **Packaging & CI**
   - Publish macOS/Linux prebuilt libraries via GitHub Releases and add checksums.
   - Add release automation for npm publishing, capturing Zig artifact uploads.

## 10. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Zig bridge diverges from Temporal core updates | Runtime incompatibilities | Pin upstream commits; add sync checklist in release process. |
| Cancellation regression on Temporal CLI dependency | Workflow management | Ensure CLI availability for integration runs, document manual fallback when the dev server is unavailable, and keep README status badges in sync. |
| Worker rewrite stalls | Teams rely on Node worker indefinitely | Deliver Bun worker incrementally (client parity first), keep Node fallback documented. |
| Native builds fail on CI | Blocks releases | Cache prebuilt libs, document Zig toolchain requirements, add `zig env` diagnostics. |

## 11. Open Questions

1. Do we want to ship official prebuilt Zig libraries for Windows, or keep Windows unsupported until Zig produces stable MSVC artifacts?
2. Should `temporal-bun` CLI embed a smoke test (`temporal-bun check --workflow <id>`) to validate signal/query once those RPCs ship?
3. How do we expose telemetry configuration ergonomically from Bun (custom config file vs. programmatic API)?
4. What is the rollout plan for swapping the Node worker fallback with the Bun-native worker in existing services (feature flag vs. semver major)?

---

This document replaces the initial draft to reflect the current Zig-based implementation and clarifies the remaining work required to deliver full client and worker parity with Temporal's TypeScript SDK.
