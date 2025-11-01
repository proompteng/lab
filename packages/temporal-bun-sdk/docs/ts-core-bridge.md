# TypeScript Core Bridge Guide

**Status Snapshot (1 Nov 2025)**  
- ✅ `src/internal/core-bridge/native.ts` dynamically loads `libtemporal_bun_bridge_zig` via `bun:ffi` and exposes strongly typed helpers for runtime/client handles.  
- ✅ `src/core-bridge/runtime.ts` and `src/core-bridge/client.ts` wrap the native handles with ergonomic classes, including `FinalizationRegistry` cleanup and TLS serialization.  
- ✅ `src/core-bridge/index.ts` intentionally exports only `native`, `runtime`, and `client`; worker orchestration now lives in `src/worker/runtime.ts` behind the Zig bridge with a documented vendor fallback.  
- ⚠️ Telemetry configuration and logger installation throw `NativeBridgeError` because the Zig bridge reports `UNIMPLEMENTED`.  
- ⚠️ Header updates share the new Zig metadata path; expand regression coverage, but cancellation now routes through the Zig bridge and returns structured codes.  

Use this guide to understand the current layering and what remains before we can drop the remaining upstream dependencies.

---

## 1. Current File Layout

```
src/
  core-bridge/
    index.ts              // Barrel exports
    runtime.ts            // Runtime wrapper (Bun-native)
    client.ts             // Client wrapper (Bun-native)
    runtime.test.ts       // Tests (to be added)
  internal/core-bridge/
    native.ts             // bun:ffi bindings + helper utilities
```

- `index.ts` re-exports `native` (raw FFI), `runtime`, and `client`. `worker` is intentionally absent until implemented.  
- Higher-level code imports `coreBridge.native` when it needs raw FFI access (e.g. `src/client.ts`). For most consumers, the wrapped classes are preferred.

---

## 2. Native Layer (`internal/core-bridge/native.ts`)

Key responsibilities:

1. **Library discovery** — resolves candidate library paths (override via `TEMPORAL_BUN_SDK_NATIVE_PATH`, packaged artefacts under `dist/native/<platform>/<arch>`, or local `bruke/zig-out/lib`). Logs failures and returns descriptive `NativeBridgeError` messages when nothing loads.  
2. **FFI symbol map** — defines the complete set of exported functions (`temporal_bun_*`) used today, including pending-handle helpers. Any new Zig export must be added here so Bun can call it.  
3. **Pointer utilities** — wraps Bun pointer types, copies `Uint8Array` results, and frees buffers on the Zig side (`temporal_bun_byte_array_free`).  
4. **Pending handle polling** — `waitForClientHandle` / `waitForByteArray` poll Zig pending handles on a microtask loop, converting errors into `NativeBridgeError`.  
5. **Error translation** — `readLastErrorPayload()` parses structured JSON from Zig (`errors.zig`); unknown strings fall back to message codes. `NativeBridgeError` captures `code`, `message`, `details`, and the raw payload for diagnostics.

When adding new exports, extend both the symbol map and the high-level wrappers. Avoid leaking raw pointers outside this module.

---

## 3. Runtime Wrapper (`core-bridge/runtime.ts`)

- Holds a `Runtime` class that allocates a Zig runtime in the constructor and registers a `FinalizationRegistry` cleanup hook.  
- Exposes:
  - `get nativeHandle()` with defensive checks (`throw` if already shut down).  
  - `configureTelemetry(options)` and `installLogger(callback)` delegate to `native.configureTelemetry` / `native.installLogger`; telemetry updates now reach Temporal core and raise `NativeBridgeError` diagnostics if payloads are invalid.  
  - `shutdown()` that is safe to call multiple times and clears the finalizer registration.

Update the doc once telemetry/logging implementations exist.

---

## 4. Client Wrapper (`core-bridge/client.ts`)

Responsibilities:

- Provide an easy way to connect and manage client handles:

```ts
const runtime = new Runtime()
const client = await Client.connect(runtime, {
  address,
  namespace,
  identity,
  apiKey,
  tls: { serverRootCACertificate, clientCert, clientPrivateKey, serverNameOverride },
})
```

- Serialize TLS settings into the shape expected by Zig (`serializeTlsOptions`).  
- Maintain namespace metadata for convenience (`client.namespace`).  
- Expose methods:
  - `describeNamespace(namespace?)` → `Uint8Array` protobuf payload.  
  - `updateHeaders(headers)` normalizes ASCII headers, base64-encodes `-bin` values, and forwards them to the Zig bridge.  
  - `shutdown()` to release the native client handle; idempotent.

A `FinalizationRegistry` ensures unattended clients still release resources, but production code should always call `shutdown()`.

---

## 5. Worker Integration

The worker lifecycle is implemented separately in `src/worker/runtime.ts` so that higher-level APIs can gate Bun-native worker startup behind feature flags (`TEMPORAL_BUN_SDK_USE_ZIG=1`) and preserve an escape hatch to the vendor (`@temporalio/worker`) fallback. Keep the `core-bridge` barrel focused on generic FFI primitives; worker wrappers should import from `internal/core-bridge/native.ts` directly until we stabilise the surface.

---

## 6. Testing Expectations

| Area | Current Coverage | TODO |
|------|------------------|------|
| Library discovery | `tests/core-bridge.test.ts` covers happy-path + failure diagnostics. | Expand to assert env override + packaged artefact fallback. |
| Runtime wrapper | N/A | Add unit tests for `shutdown`, telemetry/logger error forwarding, finalizer behaviour. |
| Client wrapper | `tests/native.test.ts` covers describeNamespace and header updates; `tests/client.test.ts` asserts ASCII/binary serialization. | Add TLS serialization coverage and negative scenarios for native failures. |
| Error handling | `tests/core-bridge.test.ts` | Keep in sync when new error codes arrive from Zig. |

When adding new FFI calls, extend the test suite with mocks to ensure argument serialization is correct before hitting the Zig layer.

---

## 7. Outstanding Items

1. Add client cancellation regression tests in `core-bridge/client.test.ts` to guard the new Zig path.  
2. Surface telemetry/logger configuration once the native bridge supports it; update docs and add unit tests.  
3. Expand coverage for metadata/header updates and TLS serialization (negative cases).  
4. Evaluate moving common error-handling utilities into a shared helper (`src/internal/core-bridge/error.ts`) if the surface grows further.

Track progress in `docs/parallel-implementation-plan.md` (lanes 1, 4, 5, and 7).

---

## 8. References

- Source: `src/internal/core-bridge/native.ts`, `src/core-bridge/runtime.ts`, `src/core-bridge/client.ts`.  
- Zig exports: `bruke/src/lib.zig`, `bruke/src/runtime.zig`, `bruke/src/client/**`.  
- Higher-level usage: `src/client.ts`, `src/bin/temporal-bun.ts`, `tests/core-bridge.test.ts`.

Keep this guide up to date whenever the bridge surface changes so contributors can rely on accurate documentation.
