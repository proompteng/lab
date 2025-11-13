# Temporal Bun Worker – Build ID Registration Investigation

**Last updated:** 2025-11-02  
**Owner:** Codex automation (gregkonush workspace)  
> **Historical note:** `TEMPORAL_BUN_SDK_USE_ZIG` has been retired; the Zig bridge
> is no longer selectable at runtime. This document remains for archival
> reference while the TypeScript runtime is the supported path.

**Scope:** `packages/temporal-bun-sdk` TypeScript worker runtime (Bun)  

---

## Executive Summary

- The Bun-native Temporal worker consistently hung whenever a build ID was provided (explicitly or via defaults) because the server never saw a compatibility registration.
- Long-poll workflows never delivered activations because the server rejected the worker’s build ID; from the client side this manifested as an endless `PollWorkflowTask` timeout loop.
- The TypeScript SDK automatically registers build IDs via `TaskQueueClient.updateBuildIdCompatibility`, but the Bun runtime never issued the analogous RPC.
- `WorkerRuntime.create()` now probes worker-versioning support with `GetWorkerBuildIdCompatibility` and, when available, registers the build ID through the `registerWorkerBuildIdCompatibility` helper before pollers start. When the probe fails with `Unimplemented`/`FailedPrecondition` (Temporal CLI dev server), the runtime logs a warning and keeps running so CI/local workflows stay green.

---

## Environment & Reproduction

| Item | Details |
| --- | --- |
| Host | macOS 15 (arm64) |
| Temporal CLI | `temporal server start-dev` via `pnpm --filter @proompteng/temporal-bun-sdk exec bun run scripts/start-temporal-cli.ts` |
| Bun Runtime | `bun test` (bundled with repo) |
| Feature Flag | _Removed (legacy `TEMPORAL_BUN_SDK_USE_ZIG`)_ |
| Build ID | Derived automatically (`<identity>-build`) unless `TEMPORAL_WORKER_BUILD_ID` is set |

### Steps to Reproduce Hang (before fix)

1. Ensure Temporal dev server is running on `127.0.0.1:7233`.
2. Execute `TEMPORAL_TEST_SERVER=1 TEMPORAL_BUN_SDK_USE_ZIG=1 pnpm --filter @proompteng/temporal-bun-sdk exec bun test tests/native.integration.test.ts`.
3. Test harness blocks indefinitely while waiting for workflow activations; LLDB shows the poller receiving `success=null`.

### Observed Logs

- Zig bridge: `worker 1 invoking worker_poll_workflow_activation (pending_polls=1)` repeating with `poll cancelled`.
- Temporal CLI UI shows workflow tasks scheduled but never delivered.

---

## Root Cause Analysis

| Finding | Evidence |
| --- | --- |
| Build ID never registered with server | The Bun worker did **not** call any worker-versioning RPC; the server treated the process as incompatible. |
| TS SDK handles registration automatically | `packages/client/src/task-queue-client.ts` issues `UpdateWorkerBuildIdCompatibility`. |
| Bun bridge relies solely on core worker creation | The worker runtime passed the build ID through deployment options but never issued `UpdateWorkerBuildIdCompatibility`, so matching refused to deliver tasks. |

**Conclusion:** Without registering the build ID, the matching service declines to hand out activations, causing the poll loop to starve.

---

## Implemented Changes

1. **TypeScript helper (`src/worker/build-id.ts`)**
   - Builds `UpdateWorkerBuildIdCompatibility` requests using the protobuf schema and retries transient `Unavailable`, `DeadlineExceeded`, `Aborted`, and `Internal` errors with incremental backoff.
   - Treats `Unimplemented`/`FailedPrecondition` as “worker versioning unavailable” so local dev servers can continue without fatal errors.

2. **Worker bootstrap (`src/worker/runtime.ts`)**
   - `WorkerRuntime.create()` now calls `GetWorkerBuildIdCompatibility` before starting pollers whenever `WorkerVersioningMode.VERSIONED` is configured.
   - Successful probes trigger build ID registration; failures propagate so deployments fail fast.
   - The CLI dev server lit up via `bun scripts/start-temporal-cli.ts` falls into the fallback path and emits a warning instead of crashing.

3. **Unit coverage**
   - `tests/worker.build-id-registration.test.ts` asserts both runtime paths: registration success and CLI fallback logging.

---

## Current Status

| Component | Status | Notes |
| --- | --- | --- |
| Zig bridge build | ✅ Passes ReleaseFast build |
| Temporal dev server | ✅ Must be running (PID referenced in `.temporal-cli.pid`) |
| Native integration test | ⚠️ Still hanging on long poll (needs rerun after ensuring server is clean and helper wired in JS layer) |
| Documentation | This file captures investigation + next steps |

---

## Outstanding Tasks

1. **Verify runtime wiring in TypeScript**
   - Ensure `WorkerRuntime.create` still surfaces errors from the Zig layer (expect `NativeBridgeError` when registration fails).

2. **Re-run integration suite end-to-end**
   - Command:  
     ```bash
     TEMPORAL_BUN_SDK_USE_ZIG=1 TEMPORAL_TEST_SERVER=1 \
       pnpm --filter @proompteng/temporal-bun-sdk exec bun test tests/native.integration.test.ts
     ```
   - Capture fresh logs; confirm activation arrives and workflow completes.

3. **Add automated coverage**
   - Introduce a Bun-side test that stubs the RPC and asserts registration call.
   - Consider a temporal CLI smoke test gated behind `TEMPORAL_TEST_SERVER`.

4. **Document runtime requirements**
   - README/CLI instructions should mention Build ID registration necessity and environment variables.

5. **Evaluate retry semantics**
   - Current helper sets `retry=true` but no per-call timeout; consider bounded retries or surfacing partial failures.

---

## Known Limitations / Risks

- **Temporal server availability:** Registration RPC will block worker startup if the CLI instance is unreachable.
- **Versioning disabled scenarios:** Helper assumes build IDs are always required; need confirmation whether “unversioned” paths should skip RPC.
- **Telemetry/logging:** Trace events write to `TEMPORAL_BUN_SDK_TRACE_PATH`; ensure this is configured in CI to aid debugging.

---

## LLDB Debugging Notes

The native bridge investigation relied heavily on LLDB. The most useful commands/settings are captured here for future sessions.

### Launching the Standalone Probe

```bash
DYLD_LIBRARY_PATH=/Users/gregkonush/github.com/sdk-core/target/debug \
  lldb -- ./check_temporal
```

> `check_temporal` is built from `packages/temporal-bun-sdk/bruke/src/check_temporal.zig` and links against the locally compiled `temporal_sdk_core_c_bridge.dylib`.

### Essential Breakpoints

| Command | Purpose |
| --- | --- |
| `br set -n temporal_core_worker_poll_workflow_activation` | Break inside the Rust core poller; confirms bridge is invoking the C-API. |
| `br set --file worker.zig --name pollWorkflowTaskWorker` | Stops on Zig poll loop entry; inspect pending handles and state machine. |
| `br set --name pollWorkflowTaskCallback` | Verifies callback receives activations; check for `user_data == null` cases. |

If symbols fail to resolve, ensure the debug dylib is on the `DYLD_LIBRARY_PATH` and LLDB is pointed at the correct binary.

### Inspecting State

```
frame variable context->worker_handle
frame variable context->pending_handle->status
thread list
bt
```

- `thread list` quickly identifies stuck Tokio threads (`__psynch_cvwait` indicates idle long polls).
- `frame variable` evaluates Zig structs; add `--depth 4` to see nested members.

### Handling Breakpoints That Pause Frequently

- Use `settings set target.inline-breakpoint-strategy always` to catch inlined functions.
- To continue past expected idle loops, run `thread continue` repeatedly or `process handle SIGSTOP -n false -p true` to ignore delivered SIGSTOP.

### Capturing Logs During Debug Sessions

Ensure the following environment variables are set before launching LLDB to get verbose Rust logs while stepping:

```bash
export RUST_LOG=temporal_sdk_core=trace,temporal_core=trace
export TEMPORAL_BUN_SDK_TRACE_PATH=/tmp/temporal-bun-trace.jsonl
```

After resuming (`continue`), tail `/tmp/temporal-bun-trace.jsonl` to correlate poll attempts with LLDB state.

### Fast Restart Workflow

1. `process kill` to terminate a wedged run.
2. `run` to restart with existing arguments.
3. Use `command history` / `!<index>` to repeat common variable inspections.

Documenting these steps reduced round-trips when verifying the build ID registration fix and will streamline future probes into the Zig bridge.

---

## References

- Temporal TypeScript SDK worker implementation: `/Users/gregkonush/github.com/sdk-typescript/packages/worker/src/worker.ts`
- Build ID client API: `/Users/gregkonush/github.com/sdk-typescript/packages/client/src/task-queue-client.ts`
- Bun worker runtime + registration helper: `packages/temporal-bun-sdk/src/worker/runtime.ts`, `packages/temporal-bun-sdk/src/worker/build-id.ts`
- Temporal CLI helper script: `packages/temporal-bun-sdk/scripts/start-temporal-cli.ts`

---

## Next Review Checkpoint

- After confirming integration tests pass and documenting the retry/backoff strategy, migrate this note into long-form developer docs or the issue tracker.
## Build ID registration update

The Bun worker now performs a capability probe (via `GetWorkerBuildIdCompatibility`) during `WorkerRuntime.create()` whenever `WorkerVersioningMode.VERSIONED` is enabled. If the WorkflowService supports worker versioning, the runtime registers the build ID with `UpdateWorkerBuildIdCompatibility` before starting pollers and logs the success.

When the probe fails with `Unimplemented` or `FailedPrecondition`—the Temporal CLI dev server started by `bun scripts/start-temporal-cli.ts` still behaves this way—the runtime logs a warning, skips registration, and continues unversioned so local/CI runs do not flake. Any other failure aborts startup because versioned task queues will continue to starve without a registered build ID.

Unit tests cover both paths today; integration coverage will land once the CLI surface exposes worker versioning APIs.
