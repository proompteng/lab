# Temporal Bun Worker – Build ID Registration Investigation

**Last updated:** 2026-02-10  
**Owner:** Codex automation (gregkonush workspace)

> **Historical note:** `TEMPORAL_BUN_SDK_USE_ZIG` has been retired; the Zig bridge
> is no longer selectable at runtime. This document remains for archival
> reference while the TypeScript runtime is the supported path.
>
> **Additional historical note (2026-02-10):** The worker-versioning v0.1 Build ID
> Compatibility APIs (`GetWorkerBuildIdCompatibility` / `UpdateWorkerBuildIdCompatibility`)
> are disabled on some namespaces (permission denied). The Temporal Bun SDK no
> longer calls these APIs in worker startup; worker versioning is handled via
> deployment metadata (deployment name + build ID) and `WorkerVersioningMode.VERSIONED`.

**Scope:** `packages/temporal-bun-sdk` TypeScript worker runtime (Bun)

---

## Executive Summary

- This document captures an investigation into Build ID Compatibility registration (Temporal “worker versioning v0.1”).
- That approach is now considered **deprecated for this repo**, because v0.1 APIs may be disabled on a namespace (permission denied).
- The current SDK behavior is:
  - enforce strict nondeterminism guards by default
  - default workers to `WorkerVersioningMode.VERSIONED` + `VersioningBehavior.PINNED` when strict
  - derive stable build IDs from workflow sources (or accept an explicit build ID)
  - do **not** call v0.1 Build ID Compatibility APIs during worker startup

---

## Environment & Reproduction

| Item         | Details                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| Host         | macOS 15 (arm64)                                                                                        |
| Temporal CLI | `temporal server start-dev` via `cd packages/temporal-bun-sdk && bun run scripts/start-temporal-cli.ts` |
| Bun Runtime  | `bun test` (bundled with repo)                                                                          |
| Feature Flag | _Removed (legacy `TEMPORAL_BUN_SDK_USE_ZIG`)_                                                           |
| Build ID     | Derived automatically (`<identity>-build`) unless `TEMPORAL_WORKER_BUILD_ID` is set                     |

### Steps to Reproduce Hang (before fix)

1. Ensure Temporal dev server is running on `127.0.0.1:7233`.
2. Execute `cd packages/temporal-bun-sdk && TEMPORAL_TEST_SERVER=1 TEMPORAL_BUN_SDK_USE_ZIG=1 bun test tests/native.integration.test.ts`.
3. Test harness blocks indefinitely while waiting for workflow activations; LLDB shows the poller receiving `success=null`.

### Observed Logs

- Zig bridge: `worker 1 invoking worker_poll_workflow_activation (pending_polls=1)` repeating with `poll cancelled`.
- Temporal CLI UI shows workflow tasks scheduled but never delivered.

---

## Root Cause Analysis

| Finding                                          | Evidence                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build ID never registered with server            | The Bun worker did **not** call any worker-versioning RPC; the server treated the process as incompatible.                                                   |
| TS SDK handles registration automatically        | `packages/client/src/task-queue-client.ts` issues `UpdateWorkerBuildIdCompatibility`.                                                                        |
| Bun bridge relies solely on core worker creation | The worker runtime passed the build ID through deployment options but never issued `UpdateWorkerBuildIdCompatibility`, so matching refused to deliver tasks. |

**Conclusion:** Without registering the build ID, the matching service declines to hand out activations, causing the poll loop to starve.

---

## Implemented Changes

This investigation originally led to a helper (`src/worker/build-id.ts`) and worker
bootstrap wiring. As of 2026-02-10, the SDK no longer uses that wiring in
`WorkerRuntime.create()` because the v0.1 APIs may be disabled on a namespace.

---

## Current Status

| Component                     | Status                | Notes                                                                            |
| ----------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| Worker versioning v0.1 APIs   | ⚠️ Not used           | Disabled on some namespaces.                                                     |
| Worker deployments versioning | ✅ Used               | `WorkerVersioningMode.VERSIONED` + `VersioningBehavior.PINNED` when strict.      |
| Nondeterminism runtime guards | ✅ Enabled by default | Strict in production; strict by default.                                         |
| Documentation                 | ✅ Updated            | This file is archival; see `docs/temporal-bun-sdk/` for current design/runbooks. |

---

## Outstanding Tasks

1. **Verify runtime wiring in TypeScript**
   - Ensure `WorkerRuntime.create` still surfaces errors from the Zig layer (expect `NativeBridgeError` when registration fails).

2. **Re-run integration suite end-to-end**
   - Command:
     ```bash
     TEMPORAL_BUN_SDK_USE_ZIG=1 TEMPORAL_TEST_SERVER=1 \
      cd packages/temporal-bun-sdk && bun test tests/native.integration.test.ts
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

| Command                                                   | Purpose                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `br set -n temporal_core_worker_poll_workflow_activation` | Break inside the Rust core poller; confirms bridge is invoking the C-API.    |
| `br set --file worker.zig --name pollWorkflowTaskWorker`  | Stops on Zig poll loop entry; inspect pending handles and state machine.     |
| `br set --name pollWorkflowTaskCallback`                  | Verifies callback receives activations; check for `user_data == null` cases. |

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
