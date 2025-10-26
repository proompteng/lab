## Zig Bridge Scaffold Checklist

The items below slice the Zig bridge effort into PR-sized TODOs. Every ID maps back to an in-line
`TODO(codex, …)` marker so contributors can grab a task without re-planning. Reference
`zig-bridge-migration-plan.md` for macro phases.

### Runtime Bootstrap

| ID | Description | Entry point | Acceptance |
|----|-------------|-------------|------------|
| zig-core-01 | Generate Temporal core headers via `cbindgen` and plumb them through `src/core.zig`. | `src/core.zig` | Headers vendored + imported; stubs removed. |
| zig-rt-01 | Replace runtime stub with calls to `temporal_sdk_core_runtime_new`. | `src/runtime.zig` | Runtime handle stores opaque pointer; error propagation verified. |
| zig-rt-02 | Release runtime through the C-ABI destructor and clear allocations. | `src/runtime.zig` | Drop routine calls C core + passes tests. |
| zig-rt-03 | Bridge telemetry updates via Temporal core C-ABI. | `src/runtime.zig`, `src/lib.zig` | `runtime.updateTelemetry` surfaces exporter wiring. |
| zig-rt-04 | Forward core logs into Bun via callback registration. | `src/runtime.zig`, `src/lib.zig` | Bun callback receives log events during tests. |

### Client Lifecycle

| ID | Description | Entry point | Acceptance |
|----|-------------|-------------|------------|
| zig-cl-01 | Implement async client connect backed by Temporal core + pending handles. | `src/client.zig`, `src/pending.zig` | `connectAsync` returns pending handle consumed by TS tests. |
| zig-cl-02 | Wire namespace describe RPC to Temporal core and return byte arrays. | `src/client.zig` | Fixture test decodes namespace info. |
| zig-cl-03 | Pass header update requests through to Temporal core metadata APIs. | `src/client.zig` | Unit test confirms headers applied. |

### Workflow RPCs

| ID | Description | Entry point | Acceptance |
|----|-------------|-------------|------------|
| zig-wf-01 | Marshal workflow start payloads and return run handles. | `src/client.zig` | Start smoke test passes via Zig bridge. |
| zig-wf-02 | Implement signal-with-start using shared marshalling path. | `src/client.zig` | Integration test covers signal and start success. |
| zig-wf-03 | Add terminate workflow RPC bridging. | `src/client.zig` | ✅ Bun/Zig tests cover terminate success and error paths. |
| zig-wf-04 | Implement workflow query RPC using pending byte arrays. | `src/client.zig` | Query integration test succeeds (native returns raw proto; TS decodes JSON payloads). |
| zig-wf-05 | Implement workflow signal FFI returning pending handle. | `src/client.zig`, `src/lib.zig` | Signal integration test passes via Zig bridge. |
| zig-wf-06 | Wire workflow cancel RPC returning pending handle. | `src/client.zig`, `src/lib.zig` | Cancel scenario passes via Zig bridge. |

### Byte Array & Pending Handles

| ID | Description | Entry point | Acceptance |
|----|-------------|-------------|------------|
| zig-buf-01 | Swap stub allocator for zero-copy handling of Temporal-owned buffers. | `src/byte_array.zig` | Roundtrip tests prove no leaks and zero-copy when possible. |
| zig-buf-02 | Add guardrails + telemetry counters for buffer allocations. | `src/byte_array.zig` | Metrics surfaced to TS layer; unit tests cover failure cases. |
| zig-pend-01 | Implement reusable pending handle state machine for clients + byte arrays. | `src/pending.zig` | Concurrent stress test passes; TS polling logic unchanged. |

### Worker Lifecycle

| ID | Description | Entry point | Acceptance |
|----|-------------|-------------|------------|
| zig-worker-01 | Instantiate Temporal core worker and expose handle creation. | `src/worker.zig`, `src/lib.zig`, `src/internal/core-bridge/native.ts`, `src/worker/runtime.ts` | ✅ Worker creation returns opaque pointer for the configured task queue; Bun helper calls the Zig bridge when `TEMPORAL_BUN_SDK_USE_ZIG=1`. |
| zig-worker-02 | Dispose worker handles and release underlying resources. | `src/worker.zig`, `src/lib.zig` | Worker shutdown frees core references without leaks. |
| zig-worker-03 | Poll workflow tasks and surface activations via pending handles. | `src/worker.zig`, `src/lib.zig` | Workflow task polling drives activation dispatch in TS tests. |
| zig-worker-04 | Complete workflow tasks with success/error payloads. | `src/worker.zig`, `src/lib.zig` | Workflow completion integration test passes. |
| zig-worker-05 | Poll activity tasks through Temporal core worker. | `src/worker.zig`, `src/lib.zig` | ✅ Activity polling returns payloads, surfaces cancellations, and handles shutdown sentinel in Bun tests. |
| zig-worker-06 | Complete activity tasks (success & failure). | `src/worker.zig`, `src/lib.zig` | Activity completion test verifies response propagation. |
| zig-worker-07 | Record activity heartbeats through FFI bridge. | `src/worker.zig`, `src/lib.zig` | Heartbeat updates visible in Temporal server during tests. |
| zig-worker-08 | Initiate graceful shutdown (stop polling). | `src/worker.zig`, `src/lib.zig` | Worker halts new polls while allowing inflight work to finish. |
| zig-worker-09 | Finalize shutdown and wait for inflight tasks. | `src/worker.zig`, `src/lib.zig` | Shutdown completes without dangling handles. |

### Tooling & Distribution

| ID | Description | Entry point | Acceptance |
|----|-------------|-------------|------------|
| zig-pack-01 | Link Zig build against Temporal static libraries emitted by Cargo. | `build.zig` | `build:native:zig` links successfully on macOS/Linux. |
| zig-pack-02 | Ship Zig artifacts in npm package (`zig-out/lib` per target). | `package.json`, publish pipeline | Pack command includes Zig binaries (Rust fallback removed). |
| zig-pack-03 | Document Zig toolchain requirements + installation flow referencing the official Zig install guide. | `README.md`, docs | README section updated, CI job references version. |
| zig-pack-04 | CI executes `zig build test` in addition to existing Rust bridge smoke tests. | CI configs | Pipeline green with dual bridge verification (see `.github/workflows/temporal-bun-sdk-zig.yml`). |

Grab a single ID, replace the matching TODO in code, and keep scope bounded so each merge delivers
an incremental capability.
