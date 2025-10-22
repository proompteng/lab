# Temporal Bun FFI Contract

This document captures the minimal contract between the Bun bindings and the Zig bridge. The intent is to provide a tiny, well
-defined surface so additional functionality can be layered without breaking existing integrations.

## Exported Symbols

All exported functions use a C ABI and return an `int32` status code. A status of `0` indicates success. Non-zero values map to a
compact enum shared between Zig and Bun.

| Symbol | Signature (Zig) | Description |
| --- | --- | --- |
| `te_client_connect` | `(config_ptr: ?[*]const u8, len: i64, out_handle: ?*u64) i32` | Creates a new client handle and writes its opaque `u64` identifier to `out_handle`. |
| `te_client_close` | `(handle: u64) i32` | Closes the client handle. Double-close returns `already_closed`. |
| `te_worker_start` | `(client_handle: u64, options_ptr: ?[*]const u8, len: i64, out_handle: ?*u64) i32` | Registers a worker associated with a client. |
| `te_worker_shutdown` | `(handle: u64) i32` | Shuts down a worker handle; idempotent with typed errors. |
| `te_get_last_error` | `(out_ptr: ?*u64, out_len: ?*u64) i32` | Returns an owned buffer containing the last error payload for the current thread. |
| `te_free_buf` | `(ptr_value: u64, len: i64) i32` | Releases buffers produced by `te_get_last_error`. |

### Status Codes

The following status values are shared between Zig and Bun:

| Code | Name | Meaning |
| --- | --- | --- |
| `0` | `ok` | Operation succeeded. |
| `1` | `invalid_argument` | Inputs were invalid (null pointers, negative lengths, closed handles). |
| `2` | `not_found` | Handle or buffer could not be located. |
| `3` | `already_closed` | Lifecycle operation invoked on an already-closed handle. |
| `4` | `busy` | Reserved for future use. |
| `5` | `internal` | Internal invariant failed. |
| `6` | `oom` | Allocation failed. |

## Error Model

* Errors are tracked per-thread. Each failing call stores a JSON payload and returns a non-zero status.
* The JSON schema is: `{"code":<int>,"msg":"...","where":"<symbol>"}`.
* `te_get_last_error` copies the payload out of the thread-local slot, registers the buffer for ownership tracking, and clears the slot.
* Callers **must** release the returned buffer with `te_free_buf(ptr,len)`. Double-free, length mismatches, and invalid pointers all
surface typed errors without crashing.

## Memory Contract

* All outgoing buffers (currently only error payloads) are allocated in Zig with the active global allocator.
* Inputs must not pass null pointers with non-zero lengths. Negative lengths yield `invalid_argument`.
* Buffer handles returned by `te_get_last_error` remain valid until `te_free_buf` is invoked. The bridge guards against double
frees and frees with mismatched lengths.

## Handle Lifecycle

* Client and worker handles are opaque `u64` identifiers. They are monotonically assigned and thread-safe.
* Closing an already-closed handle returns `already_closed` but does not crash or corrupt state.
* Worker start validates the owning client. Attempts to attach a worker to a closed or unknown client return a typed error.

## Bun Bindings

* The Bun side loads the shared library with `Bun.dlopen` and maps the status codes to a `TemporalBridgeError` class.
* Error payloads are decoded from JSON, copied into managed memory, and freed via `te_free_buf` before constructing the error.
* RAII helpers (`ClientHandle`, `WorkerHandle`) ensure handles are closed exactly once and raise typed errors on double-close.
* `TEMPORAL_BUN_BRIDGE_PATH` can override the resolved shared library path for testing or distribution overrides.

## Validation

The Zig test suite covers:

* Allocator counting to ensure no leaks remain after lifecycle operations.
* Error buffer registry correctness (double-free, invalid arguments, length mismatches).
* Eight-thread stress test that exercises connect/close sequences for 100 iterations per thread.

The Bun test suite covers:

* Error mapping and metadata exposure.
* Guaranteeing error buffers are freed after failures and that success paths leave the error slot empty.
* RAII protections (double-close) and concurrency stress across multiple asynchronous tasks.
