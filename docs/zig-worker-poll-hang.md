# Temporal Bun SDK Zig Worker Poll Hang

## Summary
- **Issue**: Bun-native worker built on the Zig bridge never receives workflow activations; `pollWorkflowTask` promise remains pending and smoke/integration tests hang.
- **First observed**: Native integration suite (`packages/temporal-bun-sdk/tests/native.integration.test.ts`) started hanging after enabling the Zig bridge end-to-end path.
- **Current state**: Investigations show discrepancies between the Zig bridge (`packages/temporal-bun-sdk/bruke/src`) and the reference TypeScript / Neon bridge (`sdk-typescript/packages/core-bridge`). Build ID wiring, polling concurrency, and pending-handle lifecycle differ enough that `WorkflowTaskScheduled` events never become `WorkflowTaskStarted` for Bun workers.

## Reproduction
1. Ensure the Temporal test-server binary (CLI) is available on PATH.
2. From the repo root, run:
   ```bash
   TEMPORAL_BUN_SDK_USE_ZIG=1 TEMPORAL_TEST_SERVER=1 pnpm --filter @proompteng/temporal-bun-sdk exec bun test native.integration.test.ts
   ```
3. Expected behaviour: test should complete within ~60s. **Actual**: worker process hangs indefinitely; Temporal CLI shows `WorkflowTaskScheduled` without matching `WorkflowTaskStarted`.

## Observed Symptoms
- `packages/temporal-bun-sdk/bruke/examples/simple_connect.zig` reproduces, printing `pollWorkflowTask timed out (hang detected)` after 30s while Temporal server queues remain stuck.
- CLI (`temporal workflow show ...`) reveals workflows terminated manually with no `WorkflowTaskStarted` event in history.
- Bun runtime log instrumentation indicates `pollWorkflowTaskWorker` never receives callback with activation payload.
- Instrumenting Rust `temporal_core_worker_poll_workflow_activation` shows poll futures resolve, but Zig bridge does not propagate result back to Bun due to pending-handle lifecycle.

## Root Cause Hypotheses
1. **Build ID mismatch**: Zig bridge currently hardcodes `WorkerOptions.versioning_strategy` to `None` with empty build ID. Temporal server routes tasks based on Build ID semantics; mismatch prevents pollers from being recognised.
2. **Pending executor interference**: The Zig bridge schedules polls through a custom `PendingExecutor`. When the executor queue saturates or shutdown flags flip, the callback may never fire, causing permit deadlock.
3. **Permit accounting**: `acquirePollPermit` increments `pending_polls`, but cancellation paths (thread spawn failure, runtime shutdown) may not release permit, leaving worker permanently barred from issuing new polls.
4. **Mismatch with reference bridge**: TypeScript/Neon bridge performs a single async poll without additional threading or pending handles. Zig implementation adds extra layers whose correctness is questionable.

## Investigation Timeline
- **2025-10-28**: Smoke suite added (`test:e2e`) to enforce Bun-native path; test immediately hangs on worker polling.
- **2025-10-29**: Added logging inside `pollWorkflowTaskCallback`; observed no success or failure callbacks, only eventual timeout.
- **2025-10-30**: Built and linked debug `sdk-core` (`v1.13.1-14-g7b0224a3`); confirmed Rust side polls succeed but results never reach Zig callback.
- **2025-10-31**: Identified Build ID gap between Bun bridge and TypeScript bridge; TypeScript automatically sets build ID via `addBuildIdIfMissing`.
- **2025-11-01**: Simplified Zig poll path to spawn threads directly (removing pending executor); hang persists, suggesting upstream server still rejects worker.

## Key Differences Between Bridges
| Behaviour | TypeScript (Neon) | Zig | Impact |
|-----------|-------------------|-----|--------|
| Build ID | Derived from package metadata (`pkg.name@pkg.version`) | Empty string | Server cannot associate worker with scheduled tasks |
| Poll implementation | Direct async `worker.poll_workflow_activation` awaited | Custom `PendingExecutor` & thread wrappers | Possible lost callbacks/permits |
| Pending handles | JS `waitForByteArray` polls userland FFI once per request | Zig retains references in shared table; needs explicit release | Error paths may leak/reject handles |
| Logger/telemetry flush | JS flushes via `runtime.flushLogs()` | Zig lacks periodic flush | Harder to observe core logs |

## Next Steps
1. **Align WorkerOptions**: Port TypeScript’s `BridgeWorkerOptions` defaults (build ID injection, poll behaviour) into Zig binding. Ensure build ID propagates via `WorkerOptions.versioning_strategy`. 
2. **Trim pending executor**: Refactor `pollWorkflowTask` to call core API synchronously (spawned thread or direct call) and resolve Bun promise immediately.
3. **Add regression doc & tests**: Extend `native.integration.test.ts` with explicit timeout to detect hang promptly.
4. **Instrument core poller**: Add temporary tracing in `pollers::poll_buffer` to confirm server requests flow.

## Links & References
- Zig bridge: `packages/temporal-bun-sdk/bruke/src/worker.zig`
- Runtime/pending executor: `packages/temporal-bun-sdk/bruke/src/runtime.zig`, `packages/temporal-bun-sdk/bruke/src/pending.zig`
- Reference Neon bridge: `sdk-typescript/packages/core-bridge/src/worker.rs`, `runtime.rs`
- Runbook Draft: TODO (pending fix)

## Status
- [ ] Build ID wired through Zig bridge
- [ ] Simplified poll path verified
- [ ] Smoke suite green
- [ ] Documentation updated (this file)
