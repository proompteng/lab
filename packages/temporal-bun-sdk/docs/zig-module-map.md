# Zig Module Map

This document captures the module boundaries inside `packages/temporal-bun-sdk/bruke/src` so concurrent work can avoid merge conflicts.

## Client Bridge

| File | Responsibility | Notes |
|------|----------------|-------|
| `client/mod.zig` | Aggregates client modules and re-exports the ABI consumed by `lib.zig`. | Touch when wiring new modules or exports only. |
| `client/common.zig` | Shared helpers (`ClientHandle`, pending-handle utilities, JSON helpers). | Owned by lane 1; changes require quick broadcast. |
| `client/connect.zig` | `connectAsync` implementation and TLS parsing. | Owns connection/error reporting. |
| `client/describe_namespace.zig` | Async DescribeNamespace RPC encoding. | Uses `common.createByteArrayError` for pending errors. |
| `client/update_headers.zig` | Client metadata updates. | Encodes newline-delimited headers and forwards to Temporal core. |

### Workflow Modules (`client/workflows/`)

| File | Responsibility | Upstream export |
|------|----------------|-----------------|
| `shared.zig` | Protobuf encoders, retry policy helpers, duration utilities. | Imported by all workflow modules. |
| `start.zig` | `temporal_bun_client_start_workflow` RPC handling. | Defines `StartWorkflowRpcContext`. |
| `signal_with_start.zig` | Signal-with-start orchestration (reuses start helpers). | Shares request encoders, handles metadata append. |
| `query.zig` | Asynchronous workflow query execution. | Spawns worker threads, resolves pending handles. |
| `signal.zig` | Workflow signal worker threads + payload validation. | Maps Temporal core errors to gRPC codes. |
| `terminate.zig` | Workflow termination RPC and status mapping. | Ensures retry-safe message handling. |
| `cancel.zig` | Workflow cancellation RPC wiring. | Resolves pending handles and maps Temporal core status codes. |

## Runtime & Worker

| File | Responsibility |
|------|----------------|
| `runtime/*.zig` | Runtime allocation, telemetry, and logger hooks. |
| `worker.zig` | Worker creation, poll/complete/heartbeat loops, and shutdown (`initiate`/`finalize`/`destroy`). |

## Aggregation

`lib.zig` imports `client.zig` (the aggregator) so existing exports stay stable while the implementation lives in modular files. Update `client/mod.zig` when introducing a new module so the ABI remains intact.

For lane ownership and testing expectations see [`docs/parallel-implementation-plan.md`](./parallel-implementation-plan.md).
