# Temporal Bun Worker – Build ID Registration Investigation

**Last updated:** 2025-11-02  
**Owner:** Codex automation (gregkonush workspace)  
**Scope:** `packages/temporal-bun-sdk` Zig bridge (Bun runtime)  

---

## Executive Summary

- The Bun-native Temporal worker consistently hangs when `TEMPORAL_BUN_SDK_USE_ZIG=1` and a build ID is provided (explicitly or via defaults).
- Long-poll workflows never deliver activations because the server rejects the worker’s build ID; from the client side this manifests as an endless `PollWorkflowTask` timeout loop.
- The TypeScript SDK automatically registers build IDs via `TaskQueueClient.updateBuildIdCompatibility`, but the Bun bridge never issued the analogous RPC.
- A new Zig helper (`packages/temporal-bun-sdk/bruke/src/client/build_id.zig`) now calls `UpdateWorkerBuildIdCompatibility` before worker creation; native rebuild succeeds. Further validation against a live Temporal CLI server is pending because integration tests still hang in CI/local runs.

---

## Environment & Reproduction

| Item | Details |
| --- | --- |
| Host | macOS 15 (arm64) |
| Temporal CLI | `temporal server start-dev` via `pnpm --filter @proompteng/temporal-bun-sdk exec bun run scripts/start-temporal-cli.ts` |
| Bun Runtime | `bun test` (bundled with repo) |
| Feature Flag | `TEMPORAL_BUN_SDK_USE_ZIG=1` |
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
| Build ID never registered with server | Zig bridge did **not** call any worker-versioning RPC; server treats the worker as incompatible. |
| TS SDK handles registration automatically | `packages/client/src/task-queue-client.ts` issues `UpdateWorkerBuildIdCompatibility`. |
| Bun bridge relies solely on core worker creation | `worker.zig` passes build ID to `worker_new`, but core refuses to deliver tasks without compatibility metadata. |

**Conclusion:** Without registering the build ID, the matching service declines to hand out activations, causing the poll loop to starve.

---

## Implemented Changes

1. **Zig helper (`client/build_id.zig`)**
   - Constructs JSON payload and invokes `core.api.client_rpc_call` with `UpdateWorkerBuildIdCompatibility`.
   - Handles success + `already_exists` (idempotent) as OK.
   - Propagates structured errors to the Bun layer if registration fails.
   - Emits trace events for diagnostics.

2. **Worker bootstrap (`worker.zig`)**
   - Before `worker_new`, ensures build ID registration succeeds.
   - Aborts worker creation on RPC failure to avoid silent hangs.

3. **Native rebuild**
   - `pnpm --filter @proompteng/temporal-bun-sdk run build:native:zig` now completes after wiring the client handle and JSON encoding.

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
- Zig bridge source: `packages/temporal-bun-sdk/bruke/src`
- Temporal CLI helper script: `packages/temporal-bun-sdk/scripts/start-temporal-cli.ts`

---

## Next Review Checkpoint

- After confirming integration tests pass and documenting the retry/backoff strategy, migrate this note into long-form developer docs or the issue tracker.
