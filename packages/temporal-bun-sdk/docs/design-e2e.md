# Temporal Bun SDK — End-to-End Design

**Author:** Platform Runtime Team  
**Original Publish Date:** 17 Oct 2025  
**Last Updated:** 25 Oct 2025  
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
- ✅ Worker bootstrap (`createWorker`, `runWorker`) keeps parity with the existing Node SDK via `@temporalio/worker`, ensuring teams can run workflows today.
- ⚠️ `client.workflow.cancel` and `client.updateHeaders` surface `NativeBridgeError` because the Zig bridge exports are still stubs; `client.workflow.signal` also depends on the placeholder signal RPC.
- ⚠️ `WorkerRuntime` (native Bun worker loop) is scaffolded in `src/worker/runtime.ts` but not yet wired to the native bridge.

### Zig native bridge (`native/temporal-bun-bridge-zig`)
- ✅ Uses `@cImport("temporal-sdk-core-c-bridge.h")` to call Temporal core runtime/client APIs.
- ✅ Implements async pending handles for client connect, DescribeNamespace, workflow queries, and workflow signals via dedicated worker threads.
- ✅ Encodes workflow start and signal-with-start requests directly in Zig, returning JSON metadata to Bun.
- ⚠️ `temporal_bun_client_signal` relies on a temporary stub in `core.zig`; it does not yet invoke Temporal core RPCs.
- ⚠️ `temporal_bun_client_cancel_workflow` and `temporal_bun_client_update_headers` return `UNIMPLEMENTED`, and `temporal_bun_client_signal` still routes through a stub helper.
- ⚠️ Worker exports (`temporal_bun_worker_*`) are placeholders; only workflow completion goes through stubbed callbacks to support unit tests.
- ⚠️ Telemetry and logger configuration hooks (`temporal_bun_runtime_update_telemetry`, `temporal_bun_runtime_set_logger`) report `UNIMPLEMENTED`.

### Tooling & Distribution
- ✅ `scripts/download-temporal-libs.ts` downloads pinned Temporal core static libs, enabling reproducible Zig builds.
- ✅ `pnpm run build:native:zig` compiles `libtemporal_bun_bridge_zig` for macOS/Linux and `package:native:zig` stages artifacts under `dist/native/<platform>/<arch>/`.
- ✅ `prepack` hook builds TypeScript, fetches native libs, compiles Zig, and packages artifacts automatically.
- ✅ `tests/native.integration.test.ts`, `tests/end-to-end-workflow.test.ts`, and `tests/zig-signal.test.ts` exercise the bridge against the Temporal CLI dev server.
- ⚠️ `zig build test` executes stubbed unit tests only; coverage for worker APIs remains TODO.

## 3. Architecture Overview

```
┌──────────────────────────────────────────┐
│ @proompteng/temporal-bun-sdk (TypeScript)│
│  ├─ Config & client helpers              │
│  ├─ Worker (Node fallback)               │
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

## 4. Native Bridge Function Matrix

| Area | Export | Status | Notes |
|------|--------|--------|-------|
| Runtime | `temporal_bun_runtime_new` / `free` | ✅ | Creates Temporal core runtime and tracks pending connects with thread-safe counters. |
| Runtime | `temporal_bun_runtime_update_telemetry` | ⚠️ TODO | Returns `UNIMPLEMENTED`; telemetry wiring planned in `zig-runtime-02`. |
| Runtime | `temporal_bun_runtime_set_logger` | ⚠️ TODO | Placeholder until Temporal core exposes logger callbacks. |
| Client | `temporal_bun_client_connect_async` | ✅ | Async connect with pending handle + thread pool. |
| Client | `temporal_bun_client_describe_namespace_async` | ✅ | Encodes protobuf request and resolves via pending handle. |
| Client | `temporal_bun_client_start_workflow` | ✅ | Encodes workflow start protobufs, returns JSON metadata. |
| Client | `temporal_bun_client_signal_with_start` | ✅ | Shares start encoder, invokes `SignalWithStartWorkflowExecution`. |
| Client | `temporal_bun_client_query_workflow` | ✅ | Spawns worker thread, decodes `QueryWorkflowResponse`, maps errors. |
| Client | `temporal_bun_client_signal` | ⚠️ Stub | Validates payloads but ultimately routes through stubbed `core.signalWorkflow`; Temporal RPC integration pending (`zig-wf-05`). |
| Client | `temporal_bun_client_terminate_workflow` | ✅ | Executes Temporal core termination RPC and propagates gRPC status codes. |
| Client | `temporal_bun_client_cancel_workflow` | ❌ Not implemented | Stub returning `UNIMPLEMENTED`. |
| Client | `temporal_bun_client_update_headers` | ❌ Not implemented | Metadata updates not yet forwarded to Temporal core. |
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
- `pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig` compiles the Zig bridge in `ReleaseFast` mode; artifacts land under `native/temporal-bun-bridge-zig/zig-out/lib/<platform>/<arch>/`.
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
- Follow-up: propagate header updates without tearing down the client once `temporal_bun_client_update_headers` is implemented.

## 8. Testing & Validation

- Bun tests:
  - `tests/native.integration.test.ts` spins up Temporal CLI dev server and exercises workflow start/query via Zig bridge.
  - `tests/end-to-end-workflow.test.ts` validates sample workflow execution.
  - `tests/zig-signal.test.ts` stresses the signal pending-handle path (currently against Zig stub).
  - `tests/client.test.ts` mocks the native module to verify payload encoding and validation logic.
- Zig tests:
  - `zig build test` covers JSON validation helpers and pending-handle state machines.
  - Worker completion tests assert callback plumbing in `worker.zig`, even though polling is unimplemented.
- Manual QA: `pnpm --filter @proompteng/temporal-bun-sdk run temporal:start` launches a local server; `bun test tests/native.integration.test.ts` performs smoke validation.

## 9. Remaining Work & Milestones

1. **Client parity**
   - Implement `temporal_bun_client_update_headers` and `cancel_workflow`, plus add end-to-end Bun tests for the `terminate_workflow` and future signal paths.
   - Replace stubbed `core.signalWorkflow` with a real Temporal RPC call.
2. **Runtime telemetry & logging**
   - Wire `temporal_bun_runtime_update_telemetry` and `*_set_logger` through Temporal core once upstream exposes the hooks.
   - Surface metrics/logging configuration helpers in TypeScript (`configureTelemetry`, `installLogger`).
3. **Worker bridge**
   - Implement worker creation, poll/complete loops, activity heartbeats, and graceful shutdown in Zig (`zig-worker-01`…`zig-worker-09`).
   - Deliver Bun `WorkerRuntime` to replace the Node fallback and update docs/CLI to default to Bun-native workers.
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
| Incomplete cancel/update/signal paths surprise users | Workflow management gaps | Mark methods as beta in README, add runtime warnings, prioritize bridge implementation. |
| Worker rewrite stalls | Teams rely on Node worker indefinitely | Deliver Bun worker incrementally (client parity first), keep Node fallback documented. |
| Native builds fail on CI | Blocks releases | Cache prebuilt libs, document Zig toolchain requirements, add `zig env` diagnostics. |

## 11. Open Questions

1. Do we want to ship official prebuilt Zig libraries for Windows, or keep Windows unsupported until Zig produces stable MSVC artifacts?
2. Should `temporal-bun` CLI embed a smoke test (`temporal-bun check --workflow <id>`) to validate signal/query once those RPCs ship?
3. How do we expose telemetry configuration ergonomically from Bun (custom config file vs. programmatic API)?
4. What is the rollout plan for swapping the Node worker fallback with the Bun-native worker in existing services (feature flag vs. semver major)?

---

This document replaces the initial draft to reflect the current Zig-based implementation and clarifies the remaining work required to deliver full client and worker parity with Temporal's TypeScript SDK.
