# Worker Runtime Implementation Guide

**Status Snapshot (27 Oct 2025)**
- ✅ `createWorker` now constructs the Bun-native runtime by default whenever the Zig bridge is available. The vendor `@temporalio/worker` implementation is only used when `TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1`.
- ✅ `WorkerRuntime` wires workflow polling to the new `WorkflowEngine`, which decodes core activations, executes workflows inside the Bun process using the TypeScript SDK runtime, and streams `WorkflowActivationCompletion` payloads back to Temporal Core.
- ✅ `WorkflowEngine` supports deterministic command generation (timers, completions) and loads workflow bundles directly from the filesystem. Unit coverage lives under `tests/worker.runtime.workflow.test.ts`.
- ⚠️ Activity task execution, heartbeats, and metrics emission remain stubbed pending #1612. Pollers are not yet started for activity lanes.
- ⚠️ Graceful shutdown honours abort semantics but still lacks drain coordination with the Zig bridge for in-flight activities.

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

## 2. Zig Bridge Hooks

`src/internal/core-bridge/native.ts` continues to surface the FFI surface required by the runtime:

- `isZigWorkerBridgeEnabled()` guards Bun worker construction behind `TEMPORAL_BUN_SDK_USE_ZIG=1` and the detected bridge variant.
- `maybeCreateNativeWorker` and `destroyNativeWorker` manage the native worker handle lifecycle.
- `native.worker.pollWorkflowTask` resolves `WorkflowActivation` byte buffers sourced from Temporal Core via the Zig bridge.
- `native.worker.completeWorkflowTask` accepts the encoded `WorkflowActivationCompletion` returned by the engine.
- Shutdown mirrors the existing logic: abort the poll loop, request native shutdown, and release runtime/client handles.

---

## 3. Remaining Runtime Work

> **Target Architecture:** The diagrams and responsibilities in this section describe the desired end state once Bun-native worker loops replace the current Node SDK dependency. They are not implemented yet.

| Component | Status | Notes |
|-----------|--------|-------|
| Workflow task loop | ✅ | `WorkflowEngine` executes workflows using the TypeScript runtime shipped in `@temporalio/workflow`. Commands are encoded as core `WorkflowActivationCompletion` payloads. |
| Activity task loop | ⚠️ | Polling and completion helpers exist in Zig but are not yet wired through the Bun runtime. Blocked on #1612 for end-to-end completion APIs. |
| Heartbeats & metrics | ⚠️ | Heartbeat streaming and metrics emission remain TODO. |
| Graceful shutdown | ⚠️ | Poll loop aborts and native shutdown work, but draining running activities is still pending. |
| Vendor fallback | ✅ | `TEMPORAL_BUN_SDK_VENDOR_FALLBACK=1` preserves the old `@temporalio/worker` code path for platforms without the Zig bridge. |

---

## 4. Implementation Roadmap

1. **Finish Zig worker exports** (lanes 7 & 5 in `parallel-implementation-plan.md`): complete/heartbeat/shutdown RPCs, ensure errors bubble up via `NativeBridgeError`.
2. **Stabilise the Bun workflow engine**: ✅ `WorkflowEngine` now decodes activations, executes workflows via the TypeScript runtime, and encodes `WorkflowActivationCompletion` payloads. Remaining work covers interceptor hot-reload support and memory profiling.
3. **Workflow runtime**: continue hardening replay determinism and feature parity (patch markers, interceptors, payload converters) per `docs/workflow-runtime.md`.
4. **Remove Node fallback**: once Bun worker reaches parity, drop the dependency on `@temporalio/worker` and update the CLI scaffolding + README.
5. **Testing**: extend `tests/worker/**` with end-to-end cases (workflow activation, activity success/failure, shutdown) and run them under `TEMPORAL_BUN_SDK_USE_ZIG=1` in CI.

---

## 5. References

- TypeScript sources: `src/worker.ts`, `src/worker/runtime.ts`, `src/internal/core-bridge/native.ts`.
- Zig worker implementation: `bruke/src/worker.zig`, `bruke/src/test_helpers.zig`.
- Documentation links: `docs/ffi-surface.md` (§7 Worker exports), `docs/workflow-runtime.md` for execution sandbox plans.
- Tests: `tests/worker.runtime.workflow.test.ts`, `tests/worker/worker-runtime-shutdown.test.ts`, and the Zig bridge suite (`tests/zig-worker-completion.test.ts`).

Keep this guide synchronized as features land so engineers always know which codepaths are live versus aspirational.
