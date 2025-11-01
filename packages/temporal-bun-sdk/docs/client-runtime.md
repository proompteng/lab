# Client Runtime Implementation Guide

**Status Snapshot (1 Nov 2025)**  
- DONE: `createTemporalClient` threads a configurable `dataConverter` through request serialization, query decoding, and signal hashing.  
- DONE: Serialization helpers now encode memo, headers, search attributes, and failure details via `encodeValuesToJson` / `encodeMapToJson`, preserving codec metadata for the Zig bridge.  
- DONE: `cancelWorkflow` now delegates to the Zig bridge implementation, returning structured gRPC status codes from Temporal core.  
- TODO: Telemetry/logging hooks from the upstream SDK remain unimplemented pending additional Zig exports.

Keep this document aligned with the current source so new work can focus on the remaining gaps rather than rediscovering the existing surface.

---

## 1. Public Surface

`src/client.ts` exports the Bun-native client. The interface mirrors the upstream Temporal TypeScript SDK where features are implemented today. Notable additions:

- `TemporalClient.dataConverter` exposes the loaded converter instance so callers can reuse it when wiring workers.
- Workflow helpers (`client.workflow.*`) delegate to the instance methods and therefore inherit the configured converter.

```ts
export interface TemporalWorkflowClient {
  start(options: StartWorkflowOptions): Promise<StartWorkflowResult>
  signal(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void>
  query(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown>
  terminate(handle: WorkflowHandle, options?: TerminateWorkflowOptions): Promise<void>
  cancel(handle: WorkflowHandle): Promise<void>
  signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult>
}

export interface TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly dataConverter: DataConverter
  readonly workflow: TemporalWorkflowClient
  startWorkflow(options: StartWorkflowOptions): Promise<StartWorkflowResult>
  signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void>
  queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown>
  terminateWorkflow(handle: WorkflowHandle, options?: TerminateWorkflowOptions): Promise<void>
  cancelWorkflow(handle: WorkflowHandle): Promise<void>
  signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult>
  describeNamespace(namespace?: string): Promise<Uint8Array>
  updateHeaders(headers: ClientMetadataHeaders): Promise<void>
  shutdown(): Promise<void>
}
```

`ClientMetadataHeaders` accepts string values for ASCII keys and `ArrayBuffer`/typed-array inputs for binary keys ending in `-bin`. The TypeScript layer base64-encodes binary payloads and rejects non-printable ASCII so Temporal core receives gRPC-compliant metadata.

---

## 2. Runtime & Native Handles

- `createTemporalClient` constructs a Zig runtime (`native.createRuntime(options.runtimeOptions ?? {})`) and retains the handle until `shutdown()` is called.  
- Every FFI call funnels through `src/internal/core-bridge/native.ts`, which loads `libtemporal_bun_bridge_zig` from either `dist/native/**` or `bruke/zig-out/lib/**`.  
- `FinalizationRegistry` guards both runtime and client handles to avoid leaking native resources if callers forget to call `shutdown()`. Tests cover that GC shutdown is a best effort only (errors are ignored during finalization).  
- When `config.allowInsecureTls` is true, the code sets `NODE_TLS_REJECT_UNAUTHORIZED = '0'` before connecting so Bun's HTTPS layer accepts self-signed Temporal endpoints.

---

## 3. Configuration Flow

`loadTemporalConfig` (in `src/config.ts`) keeps providing environment defaults and TLS handling. New in this iteration:

- Callers can pass `{ dataConverter }` into `createTemporalClient` to override the default JSON converter. The same instance is returned from the `TemporalClient` so workers can reuse it.
- The function still chooses sensible defaults for namespace, identity, and task queue; converter overrides do not affect those paths.

`createTemporalClient` augments the config with caller overrides and prepares the native payload:

```ts
const dataConverter = options.dataConverter ?? createDefaultDataConverter()
const runtime = native.createRuntime(options.runtimeOptions ?? {})
```

---

## 4. Request Serialization

`src/client/serialization.ts` centralises payload building and now depends on converter helpers:

- `buildStartWorkflowRequest` / `buildSignalWithStartRequest` encode arguments, memo, headers, and search attributes via `encodeValuesToJson` / `encodeMapToJson`. Empty collections become `{}` to satisfy Zig-side JSON decoding.
- `buildSignalRequest` and `buildQueryRequest` call the same helpers so signals, queries, and deterministic hashing share identical payloads.
- `computeSignalRequestId` hashes the converter-encoded JSON representation of arguments together with workflow identifiers, ensuring custom codecs still generate stable request IDs.
- `buildTerminateRequest` encodes failure details with the converter when provided.

`native.queryWorkflow` now returns raw payload bytes. `client.ts` decodes those bytes using `decodePayloadsToValues` before returning results to callers.

---

## 5. Error Propagation

- `NativeBridgeError` (defined in `src/internal/core-bridge/native.ts`) wraps gRPC status codes emitted by the Zig bridge.  
- `native.*` helpers convert JSON payloads or status codes into `NativeBridgeError` when the Zig layer reports failures (`temporal_bun_error_message`).  
- `signalWorkflow`, `queryWorkflow`, and `cancelWorkflow` await pending handles; cancellation now resolves via Zig and surfaces Temporal core statuses (success or failure).  
- Callers must invoke `client.shutdown()` to release native resources. The method is idempotent and safe to call multiple times.

---

## 6. Testing Coverage

| Suite | Purpose |
|-------|---------|
| `tests/client.test.ts` | Validates serialization helpers (`buildStartWorkflowRequest`, `computeSignalRequestId`, `signalWithStart` defaults) with converter-aware expectations. |
| `tests/client/serialization.test.ts` | Deterministic hashing and payload building with tunneled payloads. |
| `tests/payloads/**/*.test.ts` | Converter helpers (`encodeValuesToJson`, map handling, failure payloads). |
| `tests/native.integration.test.ts` | Runs against the Temporal CLI dev server with a custom codec to confirm end-to-end wiring. |

When adding features that touch new RPCs, extend these suites or create targeted tests to ensure regressions are caught.

---

## 7. Outstanding Work

1. **Telemetry & logging** — hook `Runtime.configureTelemetry` and `Runtime.installLogger` once the Zig exports land (`temporal_bun_runtime_update_telemetry`, `temporal_bun_runtime_set_logger`).  
2. **Determinism tooling** — expand replay/determinism harnesses so converter-driven payloads are exercised against recorded histories.  
3. **Cancellation QA** — keep integration coverage green (`tests/native.integration.test.ts`) and document manual validation steps in the README/CLI guides.

Track these items in `docs/parallel-implementation-plan.md` (lanes 1, 4, and 5) so they remain visible during planning.

---

## 8. References

- `src/client.ts`, `src/client/serialization.ts`, `src/client/types.ts`  
- `src/common/payloads/**` for converter helpers  
- `src/internal/core-bridge/native.ts`  
- `docs/payloads-codec.md` for converter design details  
- `docs/ffi-surface.md` for the current Zig export matrix

Update this guide whenever the client surface or dependencies change to keep future contributors aligned with reality.
