# Worker Runtime Implementation Guide

**Status Snapshot (30 Oct 2025)**
- ✅ `createWorker` now constructs the Bun-native runtime by default whenever the Zig bridge is available. Set `TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1` to opt back into the legacy `@temporalio/worker` codepath when the bridge is missing.
- ✅ `WorkerRuntime` wires workflow polling to the `WorkflowEngine`, which decodes core activations, executes workflows inside Bun via the Temporal TypeScript runtime, and streams `WorkflowActivationCompletion` payloads back to Temporal Core.
- ✅ Activity task execution, cancellation, and heartbeats now travel through the Zig bridge. Tests live under `tests/worker/worker-runtime-*.test.ts`.
- ✅ `loadTemporalConfig` exposes `TEMPORAL_SHOW_STACK_SOURCES`; when true, workflow stack traces include source snippets to aid debugging.
- ✅ Graceful shutdown now mirrors the Temporal Node worker: initiate shutdown fences new polls, `native.worker.finalizeShutdown` drains core, and `destroyNativeWorker` reclaims the handle; draining long-lived activity handlers remain tracked in #1612.

This document captures the live wiring and lists the remaining gaps before the Bun worker reaches feature parity with the Node SDK.

---

## 1. Current Architecture (Today)

```
createWorker(options)
  ├─ WorkerRuntime.create (provisions Zig runtime + client)
  ├─ WorkflowEngine (loads workflows, executes activations)
  └─ runWorker() -> poll → engine.process → native.completeWorkflowTask
```

- Configuration still flows through `loadTemporalConfig`; TLS overrides and address inference mirror the client logic.
- `WorkerRuntime` owns the native handles (runtime/client/worker) and the `WorkflowEngine`. It polls workflow tasks via `native.worker.pollWorkflowTask`, forwards activations to the engine, and posts completions with `native.worker.completeWorkflowTask`.
- `WorkflowEngine` maintains per-run `WorkflowEnvironment` instances. Each environment bootstraps the Temporal TypeScript runtime inside Bun, imports workflow modules from `workflowsPath`, and maps core activations to commands.
- `src/worker.ts` exposes a thin `BunWorker` facade with the same `run`/`shutdown` ergonomics as the Node SDK while retaining an opt-in path to the vendor worker for environments without the Zig bridge.
- The CLI (`src/bin/start-worker.ts`) simply instantiates the Bun worker and delegates to its lifecycle hooks.

---

## 2. Configuration Flags

- `TEMPORAL_BUN_SDK_USE_ZIG=1` — required to enable the Bun worker runtime; unset or `0` short-circuits before the bridge loads.
- `TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1` — forces the legacy `@temporalio/worker` implementation even when the bridge is available (useful for comparison or unsupported environments).
- `TEMPORAL_SHOW_STACK_SOURCES=1` — emits workflow stack traces with inline source excerpts when Temporal schedules a workflow task (defaults to `false` to keep payloads slim).
- `NODE_TLS_REJECT_UNAUTHORIZED=0` is still toggled automatically when `allowInsecureTls` is set in config; prefer TLS in production.

## 3. Zig Bridge Hooks

`src/internal/core-bridge/native.ts` surfaces the FFI surface required by the runtime:

- `isZigWorkerBridgeEnabled()` guards Bun worker construction behind `TEMPORAL_BUN_SDK_USE_ZIG=1` and the detected bridge variant.
- `maybeCreateNativeWorker`, `native.worker.finalizeShutdown`, and `destroyNativeWorker` manage the native worker handle lifecycle.
- `native.worker.pollWorkflowTask` resolves `WorkflowActivation` byte buffers sourced from Temporal Core via the Zig bridge.
- `native.worker.completeWorkflowTask` accepts the encoded `WorkflowActivationCompletion` returned by the engine.
- Shutdown mirrors the existing logic: abort the poll loop, request native shutdown, and release runtime/client handles.

---

## 4. Remaining Runtime Work

> **Target Architecture:** The diagrams and responsibilities in this section describe the desired end state once Bun-native worker loops replace the current Node SDK dependency. They are not implemented yet.

| Component | Status | Notes |
|-----------|--------|-------|
| Workflow task loop | ✅ | `WorkflowEngine` executes workflows using the TypeScript runtime shipped in `@temporalio/workflow`. Commands are encoded as core `WorkflowActivationCompletion` payloads. |
| Activity task loop | ✅ | `WorkerRuntime` polls, executes, cancels, and completes activity tasks via the Zig bridge. Heartbeats rely on native `recordActivityHeartbeat`. |
| Telemetry & metrics | ⚠️ | Activity heartbeats are live; metrics/telemetry callbacks are still stubbed in the bridge. |
| Graceful shutdown | ⚠️ | Native shutdown now issues initiate + finalize before freeing handles; draining long-running activities and reporting telemetry remain open. |
| Vendor fallback | ✅ | `TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1` preserves the old `@temporalio/worker` path when the Zig bridge is unavailable. |

---

## 5. Implementation Roadmap

1. **Finish Zig worker exports** (lanes 7 & 5 in `parallel-implementation-plan.md`): complete/heartbeat/shutdown RPCs, ensure errors bubble up via `NativeBridgeError`.
2. **Stabilise the Bun workflow engine**: ✅ `WorkflowEngine` now decodes activations, executes workflows via the TypeScript runtime, and encodes `WorkflowActivationCompletion` payloads. Remaining work covers interceptor hot-reload support and memory profiling.
3. **Workflow runtime**: continue hardening replay determinism and feature parity (patch markers, interceptors, payload converters) per `docs/workflow-runtime.md`.
4. **Remove Node fallback**: once Bun worker reaches parity, drop the dependency on `@temporalio/worker` and update the CLI scaffolding + README.
5. **Testing**: extend `tests/worker/**` with end-to-end cases (workflow activation, activity success/failure, shutdown) and run them under `TEMPORAL_BUN_SDK_USE_ZIG=1` in CI.

---

## 6. Validation Checklist

- `pnpm --filter @proompteng/temporal-bun-sdk exec bun test packages/temporal-bun-sdk/tests/worker.runtime.workflow.test.ts`
- `pnpm --filter @proompteng/temporal-bun-sdk exec bun test packages/temporal-bun-sdk/tests/worker/worker-runtime-*.test.ts`
- `TEMPORAL_TEST_SERVER=1 pnpm --filter @proompteng/temporal-bun-sdk exec bun test packages/temporal-bun-sdk/tests/native.integration.test.ts`
- `pnpm --filter @proompteng/temporal-bun-sdk build`

Keep this list in sync with issue #1454’s Definition of Done.

---

## 7. References

- TypeScript sources: `src/worker.ts`, `src/worker/runtime.ts`, `src/internal/core-bridge/native.ts`.
- Zig worker implementation: `bruke/src/worker.zig`, `bruke/src/test_helpers.zig`.
- Documentation links: `docs/ffi-surface.md` (§7 Worker exports), `docs/workflow-runtime.md` for execution sandbox plans.
- Tests: `tests/worker.runtime.workflow.test.ts`, `tests/worker/worker-runtime-shutdown.test.ts`, and the Zig bridge suite (`tests/zig-worker-completion.test.ts`).

Keep this guide synchronized as features land so engineers always know which codepaths are live versus aspirational.
