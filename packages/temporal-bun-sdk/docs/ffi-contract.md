# Temporal Bun SDK FFI Contract

## ABI surface

The Zig bridge exposes a compact C ABI with the following exports:

| Symbol | Signature | Description |
| --- | --- | --- |
| `te_client_connect` | `int32_t te_client_connect(uint64_t *out_client_id)` | Creates a client handle and returns an opaque identifier via `out_client_id`. |
| `te_client_close` | `int32_t te_client_close(uint64_t client_id)` | Marks the client handle as closed. Idempotent. |
| `te_worker_start` | `int32_t te_worker_start(uint64_t client_id, uint64_t *out_worker_id)` | Allocates a worker handle associated with an existing client. |
| `te_worker_shutdown` | `int32_t te_worker_shutdown(uint64_t worker_id)` | Shuts down a worker handle. Idempotent. |
| `te_get_last_error` | `int32_t te_get_last_error(uint8_t **out_ptr, size_t *out_len)` | Copies the thread-local error buffer pointer/length and clears the slot. |
| `te_free_buf` | `int32_t te_free_buf(uint8_t *ptr, int64_t len)` | Releases buffers allocated by the bridge (`te_get_last_error`, etc.). |

All functions return `int32_t` status codes (see below). On success, outputs are written and the slot for the last error is cleared.

## Status codes

The bridge uses a compact enum shared with TypeScript bindings:

| Code | Name |
| --- | --- |
| `0` | `Ok` |
| `1` | `InvalidArgument` |
| `2` | `NotFound` |
| `3` | `AlreadyClosed` |
| `4` | `NoMemory` |
| `5` | `Internal` |

Non-zero statuses set the thread-local error payload. The status returned by `te_get_last_error` reports problems retrieving the buffer (e.g. bad pointers, missing state).

## Error model

* Errors are stored thread-locally as UTF-8 JSON: `{"code":<int>,"message":"...","where":"<fn>"}`.
* On failure, call `te_get_last_error(&ptr,&len)` to transfer ownership of the error buffer. The slot is cleared on success.
* Call `te_free_buf(ptr,len)` exactly once for every non-null pointer returned by `te_get_last_error`.
* If an error occurs while allocating or registering the JSON payload the bridge falls back to the status code without a buffer.

## Memory contract

* Every buffer returned from the bridge is heap-allocated inside Zig and tracked in a registry.
* `te_free_buf` validates pointers and lengths:
  * `ptr == NULL && len == 0` → success (no-op).
  * `ptr == NULL && len != 0` → `InvalidArgument`.
  * `len < 0` → `InvalidArgument`.
  * Unknown pointer → `NotFound`.
  * Length mismatch → buffer freed and `InvalidArgument` returned.
* Double frees are safe and reported as `NotFound`.

## Handle lifecycle

* Client and worker handles are opaque `uint64_t` identifiers.
* Creation is thread-safe; IDs are monotonically increasing and never reused.
* Closing/shutdown is idempotent and surfaces `AlreadyClosed` without panics.
* Handle registries are guarded by mutexes to support concurrent access from multiple threads.

## TypeScript bindings

The Bun bindings load the shared library at runtime and wrap the raw symbols:

* Symbols are resolved via `bun:ffi` with explicit type metadata.
* `clientConnect`, `clientClose`, `workerStart`, and `workerShutdown` convert statuses into `TemporalBridgeError` instances.
* Errors are decoded by copying the native buffer with `toArrayBuffer`, freeing it via `te_free_buf`, and parsing the JSON payload.
* `TemporalBridgeError` exposes `.code`, `.where`, `.raw`, and `.cause` fields for diagnostics.
* `ClientHandle`/`WorkerHandle` provide RAII close semantics and throw `TemporalBridgeError` on double-close.
* `withClient(fn)` opens a client, executes `fn`, and guarantees `close()` exactly once (unless the caller closed it).

## Testing

### Zig

Run unit tests (with leak detection) from the bridge directory:

```bash
zig build -Doptimize=Debug test --build-file packages/temporal-bun-sdk/native/temporal-bun-bridge-zig/build.zig
```

### Bun

Execute the Bun-side contract tests from the package root:

```bash
cd packages/temporal-bun-sdk
bun test tests/ffi.*.test.ts
```

## CI coverage

`.github/workflows/temporal-bun-ffi.yml` provisions Bun (`1.1.20`) and Zig (`0.12.0`) on Ubuntu and macOS runners, builds the shared library (Debug + ReleaseFast), runs the Zig tests with leak checks, and executes the Bun FFI test suite. The workflow caches toolchains and fails fast if the bridge cannot be built or the tests do not pass.
