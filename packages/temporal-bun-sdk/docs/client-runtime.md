# Client Runtime Implementation Guide

**Status Snapshot (27 Oct 2025)**  
- ✅ `createTemporalClient` loads the Zig bridge (`native.createRuntime` / `native.createClient`) and exposes workflow helpers `start`, `signal`, `query`, `signalWithStart`, `terminate`, plus `describeNamespace` and `shutdown`.  
- ✅ Request payloads are assembled in `src/client/serialization.ts` and validated with Zod schemas before crossing the FFI boundary.  
- ⚠️ `cancelWorkflow` surfaces `NativeBridgeError` because the Zig bridge still reports `grpc.unimplemented`; callers receive runtime exceptions at invocation time.  
- ✅ `updateHeaders` forwards normalized ASCII/`-bin` metadata through the Zig bridge without reconnecting the client.  
- ⚠️ Runtime telemetry/logger passthroughs exist in TypeScript but throw until the Zig bridge exports are completed.  
- ✅ CLI consumers can pass TLS/API key metadata through `loadTemporalConfig`; base64 encoding happens automatically before FFI calls.  

Keep this document aligned with the current source so new work can focus on the remaining gaps rather than rediscovering the existing surface.

---

## 1. Public Surface

`src/client.ts` exports the Bun-native client. The interface mirrors the upstream Temporal TypeScript SDK where features are implemented today:

```ts
export interface TemporalWorkflowClient {
  start(options: StartWorkflowOptions): Promise<StartWorkflowResult>
  signal(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void>
  query(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown>
  terminate(handle: WorkflowHandle, options?: TerminateWorkflowOptions): Promise<void>
  cancel(handle: WorkflowHandle): Promise<void>              // throws until Zig cancel RPC lands
  signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult>
}

export interface TemporalClient {
  readonly namespace: string
  readonly config: TemporalConfig
  readonly workflow: TemporalWorkflowClient
  startWorkflow(options: StartWorkflowOptions): Promise<StartWorkflowResult>
  signalWorkflow(handle: WorkflowHandle, signalName: string, ...args: unknown[]): Promise<void>
  queryWorkflow(handle: WorkflowHandle, queryName: string, ...args: unknown[]): Promise<unknown>
  terminateWorkflow(handle: WorkflowHandle, options?: TerminateWorkflowOptions): Promise<void>
  cancelWorkflow(handle: WorkflowHandle): Promise<void>      // throws (bridge TODO)
  signalWithStart(options: SignalWithStartOptions): Promise<StartWorkflowResult>
  describeNamespace(namespace?: string): Promise<Uint8Array>
  updateHeaders(headers: ClientMetadataHeaders): Promise<void> // updates ASCII + -bin metadata via Zig bridge
  shutdown(): Promise<void>
}
```

`ClientMetadataHeaders` accepts string values for ASCII keys and `ArrayBuffer`/typed-array inputs for binary keys ending in `-bin`. The TypeScript layer base64-encodes binary payloads and rejects non-printable ASCII so Temporal core receives gRPC-compliant metadata.

The `workflow` helper simply delegates to the instance methods so higher layers can keep using familiar ergonomics (`client.workflow.start`, etc.).

---

## 2. Runtime & Native Handles

- `createTemporalClient` constructs a Zig runtime (`native.createRuntime(options.runtimeOptions ?? {})`) and retains the handle until `shutdown()` is called.  
- Every FFI call funnels through `src/internal/core-bridge/native.ts`, which loads `libtemporal_bun_bridge_zig` from either `dist/native/**` or `bruke/zig-out/lib/**`.  
- `FinalizationRegistry` guards both runtime and client handles to avoid leaking native resources if callers forget to call `shutdown()`. Tests cover that GC shutdown is a best effort only (errors are ignored during finalization).
- When `config.allowInsecureTls` is true, the code sets `NODE_TLS_REJECT_UNAUTHORIZED = '0'` before connecting so Bun’s HTTPS layer accepts self-signed Temporal endpoints.

---

## 3. Configuration Flow

`loadTemporalConfig` (in `src/config.ts`) already:

- Derives address/host/port/namespace/task queue from environment variables with sane defaults (host `127.0.0.1`, namespace `default`, task queue `prix`).  
- Reads TLS certificates/keys from disk and returns base64-ready buffers.  
- Generates a worker identity of the form `${prefix}-${hostname}-${pid}`.

`createTemporalClient` augments this with caller overrides (`options.namespace`, `identity`, `taskQueue`) and prepares the native payload:

```ts
const nativeConfig = {
  address: formatTemporalAddress(config.address, Boolean(config.tls)),
  namespace,
  identity,
  apiKey: config.apiKey,
  tls: serializeTlsConfig(config.tls),    // returns base64 strings
  allowInsecure: config.allowInsecureTls,
}
```

The same helper is used by the CLI `temporal-bun check` command so docs stay consistent.

---

## 4. Request Serialization

`src/client/serialization.ts` centralises JSON payload building. Important helpers:

- `buildStartWorkflowRequest` applies defaults for namespace/identity/task queue, coercing optional fields into snake_case keys expected by the Zig bridge.  
- `buildSignalRequest` and `buildQueryRequest` ensure workflow handles include a namespace, clone argument arrays, and attach request IDs (`computeSignalRequestId`) for idempotency.  
- `buildTerminateRequest` merges handle defaults with explicit overrides.  
- `buildSignalWithStartRequest` composes start + signal payloads.  
- `buildCancelRequest` is currently a stub that throws; the TypeScript layer catches this before the Zig bridge is invoked.

All helpers rely on Zod schemas in `src/client.ts` to validate inputs. Any failure results in a synchronous `ZodError`, mirroring the upstream SDK’s behaviour.

---

## 5. Error Propagation

- `NativeBridgeError` (defined in `src/internal/core-bridge/native.ts`) wraps gRPC status codes emitted by the Zig bridge.  
- `native.*` helpers convert JSON payloads or status codes into `NativeBridgeError` when the Zig layer reports failures (`temporal_bun_error_message`).  
- `signalWorkflow` and `queryWorkflow` await pending handles; `cancelWorkflow` still rejects because its Zig export returns `UNIMPLEMENTED`.  
- Callers must invoke `client.shutdown()` to release native resources. The method is idempotent and safe to call multiple times.

---

## 6. Testing Coverage

| Suite | Purpose |
|-------|---------|
| `tests/client.test.ts` | Validates serialization helpers (`buildStartWorkflowRequest`, `computeSignalRequestId`, signal-with-start defaults). |
| `tests/zig-signal.test.ts` | End-to-end signal flow (guarded by `TEMPORAL_TEST_SERVER=1` and Zig bridge availability). |
| `tests/native.integration.test.ts` | Starts workflows via the Zig bridge against the Temporal CLI dev server. |
| `tests/native.test.ts` | Exercises selected native wrapper utilities with stubbed bridges. |

When adding features that touch new RPCs, extend these suites or create targeted tests to ensure regressions are caught.

---

## 7. Outstanding Work

1. **Cancellation path** — finish `buildCancelRequest`, wire `native.cancelWorkflow` into the Zig bridge once `temporal_bun_client_cancel_workflow` is implemented, and add integration coverage.  
2. **Telemetry & logging** — hook `Runtime.configureTelemetry` and `Runtime.installLogger` once the Zig exports land (`temporal_bun_runtime_update_telemetry`, `temporal_bun_runtime_set_logger`).  
3. **Data converters** — today we forward raw JSON arguments. When custom payload codecs ship (see `payloads-codec.md`), update serialization to encode Temporal payloads instead of plain JSON arrays.

Track these items in `docs/parallel-implementation-plan.md` (lanes 1, 4, and 5) so they remain visible during planning.

---

## 8. References

- `src/client.ts`, `src/client/serialization.ts`, `src/client/types.ts`  
- `src/internal/core-bridge/native.ts`  
- `docs/ffi-surface.md` for the current Zig export matrix  
- `tests/native.integration.test.ts`, `tests/zig-signal.test.ts`

Update this guide whenever the client surface or dependencies change to keep future contributors aligned with reality.
