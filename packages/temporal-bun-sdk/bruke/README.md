## temporal-bun-bridge-zig (scaffold)

This directory hosts the Zig rewrite of the Temporal Bun native bridge. The initial commit only wires up
the build graph and exports stub functions so that TypeScript can experiment with the loading path. The
runtime flag `TEMPORAL_BUN_SDK_USE_ZIG` has been retired; integrating this bridge now requires explicit
hookups in the worker/client code.

### Layout

- `build.zig` — shared library target (`libtemporal_bun_bridge_zig`) plus a placeholder `zig build test`.
- `src/lib.zig` — exported symbol table matching the existing Rust bridge surface.
- `src/runtime.zig` — runtime handle lifecycle scaffold (TODO: hook into `temporalio_sdk_core` runtime).
- `src/client.zig` — client lifecycle and RPC entry points (TODO: forward to low-level Temporal C-ABI).
- `src/byte_array.zig` — helpers for managing Bun-owned buffers.
- `src/errors.zig` — temporary last-error plumbing used by the stub implementation.
- `src/core.zig` — placeholder for `@cImport` once the Rust headers are generated.

### Follow-up Checklist

The TODO markers in the source files reference these bite-sized tasks:

1. Generate C headers from `temporalio-sdk-core` crates via `cbindgen` and expose them in `src/core.zig`.
2. Replace the stubbed runtime bootstrap with real `temporalio_sdk_core_runtime_new` wiring.
3. Implement async client connect + poll/consume state machine backed by Zig worker threads.
4. Marshal byte arrays returned from Temporal core into Bun-readable buffers.
5. Port workflow RPCs (start, signal-with-start, terminate, query, cancel, signal) to Zig.
6. Expose telemetry/logger hooks once the Temporal runtime exports land.
7. Add Zig unit tests covering error propagation and the pending handle state machine.
8. Update CI scripts to build and package the Zig shared library alongside the Rust fallback.

Each item is intended to fit within a single PR for incremental delivery.
