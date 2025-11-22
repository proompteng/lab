# `@proompteng/temporal-bun-sdk`

`@proompteng/temporal-bun-sdk` is the Bun-first toolkit for Temporal clients, workers, and CLI automation. It mirrors the defaults used across this monorepo (namespace `default`, task queue `prix`, gRPC port `7233`) while adding:

- Typed environment parsing with TLS validation, retry policy shaping, and helpful error messages.
- A Connect-based WorkflowService client that ships telemetry interceptors, branded call options, and memo/search helpers.
- An Effect workflow runtime covering activities, timers, child workflows, signals, queries, updates, determinism snapshots, and replay helpers.
- Worker factories, Effect layers, and binaries (`temporal-bun`, `temporal-bun-worker`) so Bun workers can be shipped without bespoke glue.
- Structured logging plus pluggable metrics exporters shared between workers, clients, and CLI programs.

All public APIs are documented below with runnable examples. See `packages/temporal-bun-sdk-example` for a complete sample worker.

## Install & scaffold

### Create a new worker project

```bash
bunx temporal-bun init hello-worker
cd hello-worker
bun install
bun run dev
```

### Add the SDK to an existing workspace

```bash
bun add @proompteng/temporal-bun-sdk effect @effect/schema
bunx temporal-bun doctor
```

## Export map

| Target | What it exposes |
| --- | --- |
| `@proompteng/temporal-bun-sdk` | Config helpers (`loadTemporalConfig`), client factory, branded call options, Effect layers (`createTemporalCliLayer`, `createWorkerAppLayer`, `createWorkerRuntimeLayer`), CLI runner (`runTemporalCliEffect`). |
| `@proompteng/temporal-bun-sdk/config` | `TemporalConfig`, `TLSConfig`, loader functions, `applyTemporalConfigOverrides`, `TemporalConfigError`, `TemporalTlsConfigurationError`. |
| `@proompteng/temporal-bun-sdk/client` | `createTemporalClient`, `makeTemporalClientEffect`, `TemporalClient`/`TemporalWorkflowClient` types, `TemporalTlsHandshakeError`, workflow option types, memo/search helpers. |
| `@proompteng/temporal-bun-sdk/workflow` | `defineWorkflow`, signal/query/update helpers, workflow context/determinism types, workflow errors, registry/executor utilities. |
| `@proompteng/temporal-bun-sdk/workflow/runtime` | Low-level workflow executor helpers for replay diagnostics and registry customization. |
| `@proompteng/temporal-bun-sdk/worker` | `createWorker`, `runWorker`, `WorkerRuntime`, `WorkerService`, `currentActivityContext`, worker option types, deployment helpers. |
| CLI binaries | `temporal-bun` (init, doctor, docker-build, replay) and `temporal-bun-worker` (boots a worker via `runWorkerApp`). |

## Configuration API

### loadTemporalConfig / loadTemporalConfigEffect

```ts
import { loadTemporalConfig } from '@proompteng/temporal-bun-sdk'

const config = await loadTemporalConfig({
  defaults: {
    namespace: 'payments',
    taskQueue: 'payments-worker',
    rpcRetryPolicy: {
      maxAttempts: 7,
      initialDelayMs: 250,
      maxDelayMs: 5_000,
      backoffCoefficient: 2,
      jitterFactor: 0.2,
      retryableStatusCodes: [14, 4],
    },
  },
})
console.log(config.address)
```

```ts
import { Effect } from 'effect'
import { loadTemporalConfigEffect } from '@proompteng/temporal-bun-sdk'

const config = await Effect.runPromise(
  loadTemporalConfigEffect({
    env: { ...process.env, TEMPORAL_NAMESPACE: 'qa' },
  }),
)
```

### applyTemporalConfigOverrides

```ts
import { applyTemporalConfigOverrides } from '@proompteng/temporal-bun-sdk'
import { Effect } from 'effect'

const hardened = await Effect.runPromise(
  applyTemporalConfigOverrides(config, {
    logFormat: 'json',
    metricsExporter: { type: 'otlp', endpoint: 'http://localhost:4318' },
  }),
)
```

### TemporalConfig fields

| Field | Description |
| --- | --- |
| `host`, `port`, `address` | Connection details derived from env or defaults. |
| `namespace`, `taskQueue` | Namespace and default worker/client task queue. |
| `apiKey` | Injected into WorkflowService metadata when targeting Temporal Cloud. |
| `tls` | `{ serverRootCACertificate, serverNameOverride, clientCertPair }` buffers read from disk. |
| `allowInsecureTls` | Skips verification for trusted dev clusters. |
| `workerIdentity`, `workerIdentityPrefix` | Identity prefix plus resolved identity used by pollers and interceptors. |
| `showStackTraceSources` | Enables Bun source references in activity/workflow stacks. |
| `workerWorkflowConcurrency`, `workerActivityConcurrency` | Poller concurrency defaults for workers. |
| `workerStickyCacheSize`, `workerStickyTtlMs`, `stickySchedulingEnabled` | Sticky cache sizing and TTL controls. |
| `activityHeartbeatIntervalMs`, `activityHeartbeatRpcTimeoutMs` | Heartbeat throttle + RPC timeout. |
| `workerDeploymentName`, `workerBuildId` | Metadata fed into worker versioning registration. |
| `logLevel`, `logFormat` | Configures the shared logger. |
| `metricsExporter` | `{ type: 'in-memory'|'file'|'prometheus'|'otlp', endpoint?: string }`. |
| `rpcRetryPolicy` | `TemporalRpcRetryPolicy` consumed by `createTemporalClient`. |

### Configuration errors

- `TemporalConfigError` surfaces invalid ports, retry settings, or missing required values.
- `TemporalTlsConfigurationError` is raised when TLS files are unreadable, empty, or invalid PEM.
- `TemporalTlsHandshakeError` wraps runtime TLS failures when the client or worker connects.

### Environment variables

**Connection and security**

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `${TEMPORAL_HOST}:${TEMPORAL_GRPC_PORT}` | Direct override for host:port. |
| `TEMPORAL_HOST` | `127.0.0.1` | Host used when `TEMPORAL_ADDRESS` is unset. |
| `TEMPORAL_GRPC_PORT` | `7233` | Temporal gRPC port. |
| `TEMPORAL_NAMESPACE` | `default` | Namespace injected into clients and workers. |
| `TEMPORAL_TASK_QUEUE` | `prix` | Default worker task queue. |
| `TEMPORAL_API_KEY` | _unset_ | Temporal Cloud API key. |
| `TEMPORAL_TLS_CA_PATH` | _unset_ | Root CA bundle. |
| `TEMPORAL_TLS_CERT_PATH` / `TEMPORAL_TLS_KEY_PATH` | _unset_ | Client mTLS pair. |
| `TEMPORAL_TLS_SERVER_NAME` | _unset_ | TLS server name override. |
| `TEMPORAL_ALLOW_INSECURE` / `ALLOW_INSECURE_TLS` | `false` | Disable TLS verification for dev clusters. |

**Worker runtime and identity**

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEMPORAL_WORKER_IDENTITY_PREFIX` | `temporal-bun-worker` | Prefix used when deriving worker identity. |
| `TEMPORAL_SHOW_STACK_SOURCES` | `false` | Enables Bun source annotations in stack traces. |
| `TEMPORAL_WORKFLOW_CONCURRENCY` | `4` | Workflow task concurrency. |
| `TEMPORAL_ACTIVITY_CONCURRENCY` | `4` | Activity task concurrency. |
| `TEMPORAL_STICKY_CACHE_SIZE` | `128` | Sticky cache capacity. |
| `TEMPORAL_STICKY_TTL_MS` | `300000` | Sticky cache TTL. |
| `TEMPORAL_STICKY_SCHEDULING_ENABLED` | `true` | Enables sticky queue scheduling when cache > 0. |
| `TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS` | `5000` | Heartbeat throttle. |
| `TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS` | `5000` | Heartbeat RPC timeout. |
| `TEMPORAL_WORKER_DEPLOYMENT_NAME` | task-queue derived | Worker deployment metadata for versioning. |
| `TEMPORAL_WORKER_BUILD_ID` | derived from package version | Build ID registered when worker versioning is enabled. |

**Observability and retry control**

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEMPORAL_LOG_FORMAT` | `pretty` | `pretty` or `json`. |
| `TEMPORAL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |
| `TEMPORAL_METRICS_EXPORTER` | `in-memory` | `in-memory`, `file`, `prometheus`, `otlp`. |
| `TEMPORAL_METRICS_ENDPOINT` | _unset_ | File path or endpoint for selected exporter. |
| `TEMPORAL_CLIENT_RETRY_MAX_ATTEMPTS` | `5` | WorkflowService RPC attempt budget. |
| `TEMPORAL_CLIENT_RETRY_INITIAL_MS` | `200` | First retry delay. |
| `TEMPORAL_CLIENT_RETRY_MAX_MS` | `5000` | Max retry delay. |
| `TEMPORAL_CLIENT_RETRY_BACKOFF` | `2` | Backoff coefficient. |
| `TEMPORAL_CLIENT_RETRY_JITTER_FACTOR` | `0.2` | Decorrelated jitter ratio. |
| `TEMPORAL_CLIENT_RETRY_STATUS_CODES` | `UNAVAILABLE,DEADLINE_EXCEEDED` | Comma- or space-separated Connect codes to retry. |

## Client API

### createTemporalClient

```ts
import { createTemporalClient, temporalCallOptions } from '@proompteng/temporal-bun-sdk'

const { client } = await createTemporalClient({
  namespace: 'payments',
  identity: 'payments-cli',
})

const start = await client.startWorkflow({
  workflowId: `hello-${Date.now()}`,
  workflowType: 'helloWorkflow',
  args: ['Proompteng'],
  taskQueue: 'prix',
})

await client.signalWorkflow(
  start.handle,
  'complete',
  { ok: true },
  temporalCallOptions({ timeoutMs: 5_000, headers: { 'x-trace-id': 'demo' } }),
)

await client.terminateWorkflow(start.handle, { reason: 'demo finished' })
await client.shutdown()
```

### TemporalClient surface

| Member | Description |
| --- | --- |
| `startWorkflow(options, callOptions?)` | Starts a workflow run, returning `StartWorkflowResult`. |
| `signalWorkflow(handle, signalName, ...args)` | Sends a signal, auto-detecting branded call options. |
| `signalWithStart(options, callOptions?)` | Sends a signal and starts the workflow atomically. |
| `queryWorkflow(handle, queryName, ...args)` | Executes a query with optional reject conditions. |
| `terminateWorkflow(handle, options?, callOptions?)` | Terminates a workflow and optionally passes details. |
| `cancelWorkflow(handle, callOptions?)` | Requests cancellation. |
| `updateWorkflow(handle, options, callOptions?)` | Issues a workflow update and waits for the configured stage. |
| `awaitWorkflowUpdate(handle, options?, callOptions?)` | Waits for an existing update to reach a stage. |
| `cancelWorkflowUpdate(handle)` | Cancels a pending workflow update. |
| `getWorkflowUpdateHandle(handle, updateId, firstExecutionRunId?)` | Rehydrates an update handle for later awaits. |
| `describeNamespace(namespace?, callOptions?)` | Runs `DescribeNamespace` and returns Uint8Array proto bytes. |
| `memo.encode/decode` | Converts plain objects to/from `Memo` using the client data converter. |
| `searchAttributes.encode/decode` | Converts objects to/from `SearchAttributes`. |
| `workflow` | Namespaced helper exposing the same operations plus `TemporalWorkflowClient` helpers. |
| `updateHeaders(headers)` | Merges default headers for future calls. |
| `shutdown()` | Flushes interceptors, closes transports. |

### Branded call options

```ts
import { temporalCallOptions } from '@proompteng/temporal-bun-sdk'

await client.signalWorkflow(
  handle,
  'unblock',
  { stage: 'ready' },
  temporalCallOptions({
    timeoutMs: 2_000,
    headers: { 'x-user-id': '42' },
  }),
)
```

### Memo and search attribute helpers

```ts
const memo = await client.memo.encode({ release: '2024.11.0' })
const search = await client.searchAttributes.encode({ CustomerId: 123, Region: 'us-west-2' })

await client.startWorkflow({
  workflowId: 'customer-123',
  workflowType: 'onboardCustomer',
  args: [{ customerId: 123 }],
  memo,
  searchAttributes: search,
})
```

### Workflow updates from the client

```ts
const update = await client.workflow.update(handle, {
  updateName: 'setCounter',
  args: [42],
  waitForStage: 'accepted',
})

await client.workflow.awaitUpdate(update.handle, { waitForStage: 'completed' })
```

### Effect-based clients

```ts
import { Effect } from 'effect'
import {
  createTemporalClientLayer,
  TemporalClientService,
} from '@proompteng/temporal-bun-sdk'

const program = Effect.gen(function* () {
  const client = yield* TemporalClientService
  const start = yield* Effect.promise(() =>
    client.startWorkflow({ workflowId: 'effect-demo', workflowType: 'timerWorkflow' }),
  )
  yield* Effect.promise(() => client.signalWorkflow(start.handle, 'complete'))
})

await Effect.runPromise(program.pipe(Effect.provide(createTemporalClientLayer())))
```

`createTemporalClient` throws `TemporalTlsHandshakeError` when the underlying transport rejects TLS/HTTP2. The `cause` includes the original socket error to ease debugging.

## Workflow authoring API

```ts
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import {
  defineWorkflow,
  defineWorkflowSignals,
  defineWorkflowQueries,
  defineWorkflowUpdates,
} from '@proompteng/temporal-bun-sdk/workflow'

const signals = defineWorkflowSignals({
  unblock: Schema.String,
  finish: Schema.Struct({}),
})

const queries = defineWorkflowQueries({
  status: {
    input: Schema.Struct({}),
    output: Schema.Struct({ state: Schema.String }),
  },
})

const [setState] = defineWorkflowUpdates([
  {
    name: 'setState',
    input: Schema.String,
    handler: async (_ctx, value) => Effect.sync(() => value),
  },
])

export const orchestratorWorkflow = defineWorkflow({
  name: 'orchestratorWorkflow',
  schema: Schema.Array(Schema.String),
  signals,
  queries,
  updates: [setState],
  handler: ({ input, activities, signals, queries, updates, determinism }) =>
    Effect.gen(function* () {
      const [name = 'Temporal'] = input
      let state = 'waiting'

      yield* queries.register(queries.status, () => Effect.sync(() => ({ state })))
      yield* updates.register(setState, (_ctx, next) =>
        Effect.sync(() => {
          state = next
          return state
        }),
      )

      yield* signals.waitFor(signals.unblock)
      yield* activities.schedule('recordGreeting', [name])
      const timestamp = new Date(determinism.now()).toISOString()
      yield* signals.waitFor(signals.finish)
      return `${name}:${timestamp}`
    }),
})
```

Workflow context highlights:

- `activities.schedule` / `activities.cancel`
- `timers.start` / `timers.cancel`
- `childWorkflows.start`
- `signals.signal`, `signals.waitFor`, `signals.drain`, `signals.requestCancel`
- `queries.register`, `queries.resolve`
- `updates.register`, `updates.registerDefault`
- `determinism.now`, `determinism.random`, `determinism.sideEffect`, `determinism.getVersion`, `determinism.localActivity`
- `upsertSearchAttributes`, `upsertMemo`, `cancelWorkflow`, `continueAsNew`

Key errors: `WorkflowNondeterminismError`, `WorkflowBlockedError`, `WorkflowQueryViolationError`, `ContinueAsNewWorkflowError`, `WorkflowQueryHandlerMissingError`.

## Activity toolkit

```ts
import { currentActivityContext } from '@proompteng/temporal-bun-sdk/worker'

export const ingestLargeFile = async (chunks: Uint8Array[]) => {
  const ctx = currentActivityContext()
  let processed = 0

  for (const chunk of chunks) {
    await Bun.sleep(0)
    processed += 1
    await ctx?.heartbeat({ processed })
    ctx?.throwIfCancelled()
  }

  return processed
}
```

`activityContext.info` exposes activity IDs, attempt numbers, timeouts, workflow metadata, and the last heartbeat payload. `heartbeat` respects `TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS` and retries transient failures using the configured heartbeat RPC timeout.

## Worker runtime and layers

### createWorker / runWorker

```ts
import { fileURLToPath } from 'node:url'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'
import * as activities from './activities/index.ts'

const { worker } = await createWorker({
  activities,
  workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
  taskQueue: 'payments-worker',
  namespace: 'payments',
  deployment: { name: 'payments', versioningMode: 1 },
})

await worker.run()
```

### CreateWorkerOptions

| Option | Description |
| --- | --- |
| `config` | Pre-resolved `TemporalConfig` (skips env loading). |
| `taskQueue`, `namespace` | Overrides for the task queue or namespace. |
| `workflowsPath`, `workflows` | Workflow discovery controls. |
| `activities` | Record of activity handlers. |
| `dataConverter` | Custom payload converter. |
| `identity` | Worker identity override. |
| `deployment` | `WorkerDeploymentConfig` (name, buildId, versioning mode/behavior). |

### WorkerRuntimeOptions

| Option | Description |
| --- | --- |
| `workflowsPath`, `workflows`, `activities` | Same as `CreateWorkerOptions`. |
| `taskQueue`, `namespace`, `identity`, `config` | Overrides for runtime metadata. |
| `workflowService` | Inject an existing WorkflowService client. |
| `logger`, `metrics`, `metricsExporter` | Override observability sinks. |
| `dataConverter` | Custom payload converter. |
| `concurrency` | `{ workflow?: number; activity?: number }`. |
| `pollers` | `{ workflow?: number }` to decouple poller count from concurrency. |
| `stickyCache` | `{ size?: number; ttlMs?: number }` or a sticky cache instance. |
| `stickyScheduling` | Force-enable or disable sticky scheduling. |
| `deployment` | `WorkerDeploymentConfig`. |
| `schedulerHooks` | Observability hooks for custom schedulers. |

### Effect-powered workers

```ts
import { Effect } from 'effect'
import {
  createWorkerRuntimeLayer,
  WorkerRuntimeService,
} from '@proompteng/temporal-bun-sdk'

const program = Effect.gen(function* () {
  const runtime = yield* WorkerRuntimeService
  yield* Effect.promise(() => runtime.run())
})

await Effect.runPromise(
  program.pipe(
    Effect.provide(
      createWorkerRuntimeLayer({
        workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
      }),
    ),
  ),
)
```

`WorkerService` wraps `createWorker` in an Effect service, and `createWorkerAppLayer` + `runWorkerApp` compose config, observability, workflow service, and worker runtime layers. The `temporal-bun-worker` binary simply calls `runWorkerApp` with discovered workflows and activities:

```bash
bunx temporal-bun-worker
```

## CLI and tooling

| Command | Purpose | Key flags |
| --- | --- | --- |
| `temporal-bun init [directory]` | Scaffold a Bun worker project. | `--force` overwrites files. |
| `temporal-bun doctor` | Loads config, spins up logging + metrics, prints a summary. | `--log-format`, `--log-level`, `--metrics`, `--metrics-exporter`, `--metrics-endpoint`. |
| `temporal-bun docker-build` | Runs `docker build` with sensible defaults. | `--tag`, `--context`, `--file`. |
| `temporal-bun replay` | Replays workflow histories to detect nondeterminism. | `--history-file`, `--execution`, `--workflow-type`, `--namespace`, `--temporal-cli`, `--source cli|service|auto`, `--json`. |
| `temporal-bun help` | Prints usage and flag descriptions. | — |

```bash
bunx temporal-bun doctor --log-format json --metrics file:/tmp/metrics.json
```

```bash
bunx temporal-bun replay \
  --history-file packages/temporal-bun-sdk/tests/replay/fixtures/timer-workflow.json \
  --workflow-type timerWorkflow \
  --namespace temporal-bun-integration \
  --json
```

```bash
bunx temporal-bun docker-build --tag registry.example.com/payments-worker:latest --file Dockerfile.worker
```

```bash
bunx temporal-bun init payments-worker --force
```

### runTemporalCliEffect

```ts
import { Effect } from 'effect'
import { runTemporalCliEffect, TemporalConfigService } from '@proompteng/temporal-bun-sdk'

await runTemporalCliEffect(
  Effect.gen(function* () {
    const config = yield* TemporalConfigService
    console.log(`Namespace: ${config.namespace}`)
  }),
  { config: { defaults: { namespace: 'staging', taskQueue: 'staging-worker' } } },
)
```

## Workflow and client option reference

| Type | Key fields |
| --- | --- |
| `StartWorkflowOptions` | `workflowId`, `workflowType`, `args`, `taskQueue`, `namespace`, `identity`, `cronSchedule`, `memo`, `headers`, `searchAttributes`, `requestId`, timeout fields, `retryPolicy`. |
| `SignalWithStartOptions` | Extends `StartWorkflowOptions` with `signalName`, `signalArgs`. |
| `TerminateWorkflowOptions` | `reason`, `details`, `firstExecutionRunId`, `runId`. |
| `WorkflowUpdateOptions` | `updateName`, `args`, `headers`, `updateId`, `waitForStage`, `firstExecutionRunId`. |
| `WorkflowUpdateAwaitOptions` | `waitForStage`, `firstExecutionRunId`. |
| `TemporalClientCallOptions` | `headers`, `signal`, `timeoutMs`, `retryPolicy`, `queryRejectCondition`. |

## Additional resources

- `packages/temporal-bun-sdk-example` — runnable Bun worker showcasing workflows, activities, tests, and Docker packaging.
- `packages/temporal-bun-sdk/tests/replay` — determinism replay fixtures used by `temporal-bun replay`.

## License

MIT © ProomptEng AI
