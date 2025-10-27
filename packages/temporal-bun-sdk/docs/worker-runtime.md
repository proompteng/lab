# Worker Runtime Implementation Guide

**Status Snapshot (27 Oct 2025)**  
- ✅ Shipping worker experience still relies on the upstream `@temporalio/worker`. `src/worker.ts` wraps `Worker.create`, and `src/bin/start-worker.ts` simply starts the vendor worker with our default config.  
- ✅ The Zig bridge now drives real workflow poll/completion loops when `TEMPORAL_BUN_SDK_USE_ZIG=1`. `tests/worker/zig-poll-workflow.test.ts` and `tests/zig-worker-completion.test.ts` assert activations flow through Temporal core and completions are acknowledged.  
- ⚠️ `src/worker/runtime.ts` boots a minimal `WorkerRuntime` that responds to activations with empty command sets. Workflow execution and command generation remain TODO.  
- ⚠️ Activity polling/completion, heartbeats, and graceful shutdown are still tracked under `TODO(codex, zig-worker-05+)`.  
- ❌ No Bun-native workflow runtime exists; workflows still execute inside the Node SDK sandbox. See `docs/workflow-runtime.md` for the roadmap.

This document captures the current wiring and, in the sections tagged **Target Architecture**, the envisioned Bun-native worker once the Zig bridge supports full task handling.

---

## 1. Current Architecture (Today)

```
createWorker(options)
  ├─ NativeConnection.connect (Temporal Node SDK)
  ├─ Worker.create (from @temporalio/worker)
  └─ runWorker() -> worker.run()
```

- Configuration comes from `loadTemporalConfig`, identical to the client flow.  
- Activities default to `src/activities/index.ts`.  
- Sample workflows in `src/workflows/index.ts` use upstream helpers (`proxyActivities`) and execute in the Node SDK runtime.  
- The CLI entry point (`src/bin/start-worker.ts`) installs SIGINT/SIGTERM handlers and relies on `worker.shutdown()` from the Node SDK.

---

## 2. Zig Bridge Hooks (Experimental)

`src/worker/runtime.ts` and `src/internal/core-bridge/native.ts` expose helpers that now power the experimental Bun-native worker:

- `isZigWorkerBridgeEnabled()` — checks both `TEMPORAL_BUN_SDK_USE_ZIG` and the loaded bridge variant.  
- `maybeCreateNativeWorker({ runtime, client, namespace, taskQueue, identity })` — validates inputs and calls `native.createWorker`. Throws `NativeBridgeError` when prerequisites are missing.  
- `destroyNativeWorker(worker)` — frees the worker handle if it exists.  
- `WorkerRuntime.create()` loads Temporal config, provisions native runtime/client handles, and instantiates a Zig worker when the bridge flag is enabled.  
- `WorkerRuntime.run()` launches a workflow polling loop, decodes `PollWorkflowTaskQueueResponse` payloads, and acknowledges each activation with an empty `RespondWorkflowTaskCompletedRequest`.  
- `WorkerRuntime.shutdown()` aborts the polling loop and disposes the Zig handles. Graceful draining, activity lanes, and heartbeat streaming remain TODO.

On the Zig side (`bruke/src/worker.zig`):

- Creation validates config, saves copies of namespace/task queue/identity, and stores the Temporal core worker pointer.  
- Workflow polling/completion now marshal activations through pending handles and pipe completions back to Temporal core; activity completion, heartbeats, and shutdown still carry `TODO` markers.  
- Unit tests cover permit bookkeeping, activation success/failure, and completion error propagation.

---

## 3. Target Bun-Native Runtime (Future Work)

> **Target Architecture:** The diagrams and responsibilities in this section describe the desired end state once Bun-native worker loops replace the current Node SDK dependency. They are not implemented yet.

```
createWorker(options)
  ├─ WorkerRuntime (manages lifecycle)
  │   ├─ WorkflowTaskLoop (poll/dispatch)
  │   ├─ ActivityTaskLoop (poll/dispatch)
  │   ├─ ShutdownController
  │   └─ MetricsEmitter / Logger hooks
  └─ Workflow Isolate Manager (per-workflow execution context)
```

```mermaid
stateDiagram-v2
  [*] --> Initializing
  Initializing --> PollingWorkflow : spawn workflow loops
  Initializing --> PollingActivity : spawn activity loops
  PollingWorkflow --> ExecutingWorkflow : activation received
  ExecutingWorkflow --> PollingWorkflow : completion sent
  PollingActivity --> ExecutingActivity : activity task received
  ExecutingActivity --> PollingActivity : response sent
  PollingWorkflow --> ShuttingDown : shutdown signal
  PollingActivity --> ShuttingDown : shutdown signal
  ShuttingDown --> Finalizing : finalize native worker
  Finalizing --> [*]
```

`WorkerRuntime` responsibilities once implemented:

| Component | Duties |
|-----------|--------|
| Native worker lifecycle | Own Zig handles; ensure `destroyNativeWorker` runs during shutdown or GC finalization. |
| Poll loops | Call `native.worker.pollWorkflowTask` / `pollActivityTask`, translate pending handles into promises, and dispatch to workflow/activity executors. |
| Workflow runtime integration | Load workflow bundles via Bun (see `docs/workflow-runtime.md` once implemented). |
| Activity execution | Invoke registered activities with cancellation/timeouts, send results via `native.worker.completeActivityTask`. |
| Heartbeats & metrics | Stream heartbeats (`recordActivityHeartbeat`) and surface counters for task throughput/latency. |
| Shutdown semantics | Implement two-phase shutdown (initiate → finalize) mirroring the Node SDK to keep determinism guarantees.

---

## 4. Implementation Roadmap

1. **Finish Zig worker exports** (lanes 7 & 5 in `parallel-implementation-plan.md`): complete/heartbeat/shutdown RPCs, ensure errors bubble up via `NativeBridgeError`.  
2. **Add Bun worker runtime loops**: ✅ Minimal `WorkerRuntime.create/run/shutdown` logic now instantiates Zig handles and acknowledges workflow activations; follow-up work will route commands, activities, and graceful shutdown semantics.  
3. **Workflow runtime**: replace Node sandbox with Bun-native implementation (see companion doc).  
4. **Remove Node fallback**: once Bun worker reaches parity, drop the dependency on `@temporalio/worker` and update the CLI scaffolding + README.  
5. **Testing**: extend `tests/worker/**` with end-to-end cases (workflow activation, activity success/failure, shutdown) and run them under `TEMPORAL_BUN_SDK_USE_ZIG=1` in CI.

---

## 5. References

- TypeScript sources: `src/worker.ts`, `src/worker/runtime.ts`, `src/internal/core-bridge/native.ts`.  
- Zig worker implementation: `bruke/src/worker.zig`, `bruke/src/test_helpers.zig`.  
- Documentation links: `docs/ffi-surface.md` (§7 Worker exports), `docs/workflow-runtime.md` for execution sandbox plans.  
- Tests: `tests/worker/**` (currently placeholders) and `tests/zig-worker-completion.test.ts` for the existing stubs.

Keep this guide synchronized as features land so engineers always know which codepaths are live versus aspirational.
