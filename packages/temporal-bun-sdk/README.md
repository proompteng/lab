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

The loader reads environment variables, merges defaults, validates TLS material, and returns a `TemporalConfig`. Use the async helper when you are outside Effect, and the Effect version when composing layers.

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

Use overrides to patch or validate structured fields (metrics exporter, TLS buffers, retry policy) before handing the config to workers or clients.

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

## Observability

The SDK shares a logger and metrics registry between clients, workers, and CLI tools. Configure the sinks with the same environment variables:

- `TEMPORAL_LOG_FORMAT` – `pretty` or `json`.
- `TEMPORAL_LOG_LEVEL` – `debug`, `info`, `warn`, or `error`.
- `TEMPORAL_METRICS_EXPORTER` / `TEMPORAL_METRICS_ENDPOINT` – choose `in-memory`, `file`, `prometheus`, or `otlp` and point to a path/URL.

Verify everything without running a worker by using the doctor command:

```bash
bunx temporal-bun doctor --log-format=json --metrics=file:/tmp/metrics.json
```

The command loads the shared config, emits a structured log, increments a counter, flushes the exporter, and prints a summary so you can wire it into CI or preflight checks.

## Layered bootstrap helpers

Effect layers let clients, workers, and CLI commands share configuration, logging, metrics, and WorkflowService transports without manual wiring.

- `createConfigLayer()` yields `TemporalConfigService`, reading env defaults plus overrides.
- `createObservabilityLayer()` wires logger + metrics registries/exporters with the resolved config.
- `createWorkflowServiceLayer()` constructs the Connect transport with the default interceptors.
- `createWorkerRuntimeLayer()`/`runWorkerEffect()` combine everything into a managed worker runtime.

```ts
import { Effect, Layer } from 'effect'
import {
  createConfigLayer,
  createObservabilityLayer,
  createWorkflowServiceLayer,
} from '@proompteng/temporal-bun-sdk/runtime/effect-layers'
import { runWorkerEffect } from '@proompteng/temporal-bun-sdk/worker/layer'

const configLayer = createConfigLayer({
  defaults: {
    address: '10.0.0.5:7233',
    namespace: 'staging',
    taskQueue: 'staging-worker',
  },
})
const observabilityLayer = createObservabilityLayer().pipe(Layer.provide(configLayer))
const workflowLayer = createWorkflowServiceLayer()
  .pipe(Layer.provide(configLayer))
  .pipe(Layer.provide(observabilityLayer))

await Effect.runPromise(
  Effect.scoped(
    runWorkerEffect({
      workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
    })
      .pipe(Layer.provide(configLayer))
      .pipe(Layer.provide(observabilityLayer))
      .pipe(Layer.provide(workflowLayer)),
  ),
)
```

Prefer zero-boilerplate? `createWorker()` and `runWorkerApp()` wrap the same layers, discover workflows/activities from the default template, and derive worker build IDs automatically. `runTemporalCliEffect(effect, options)` runs any Effect program (doctor, replay, diagnostics) against the shared stack, so CLI commands inherit identical wiring.

## Client API

### createTemporalClient

Creates a WorkflowService client with observability interceptors, branded call options, memo/search helpers, and typed workflow helpers.

```ts
import { createTemporalClient, temporalCallOptions } from '@proompteng/temporal-bun-sdk'

const { client, config } = await createTemporalClient({
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

const value = await client.queryWorkflow(start.handle, 'status')
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
| `workflow` | Namespaced helper exposing the same operations as above plus `TemporalWorkflowClient` helpers (`start`, `signal`, `query`, `update`, `awaitUpdate`, `cancelUpdate`). |
| `updateHeaders(headers)` | Merges default headers for future calls. |
| `shutdown()` | Flushes interceptors, closes transports. |

### Branded call options

Use `temporalCallOptions` to pass headers, timeouts, or retry overrides without confusing payload arguments.

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

`makeTemporalClientEffect` and `createTemporalClientLayer` integrate with Effect services so CLI utilities and workers can share the same transport, logger, and metrics registry.

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

### defineWorkflow, signals, queries, and updates

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

### Workflow template (proxyActivities)

```ts title="workers/workflows.ts"
import { proxyActivities } from '@proompteng/temporal-bun-sdk'
import type { Activities } from '../activities.ts'

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '1 minute',
})

export async function helloWorkflow(name: string): Promise<string> {
  await activities.sleep(10)
  return await activities.echo({ message: `Hello, ${name}!` })
}
```

Bundle the exports so the worker can register them all at once:

```ts title="workers/workflows/index.ts"
export * from './workflows.ts'
```

### Workflow context capabilities

| Property | Description |
| --- | --- |
| `context.input` | Typed workflow arguments derived from the provided schema. |
| `context.info` | Metadata (`namespace`, `taskQueue`, `workflowId`, `runId`, `workflowType`). |
| `activities.schedule(type, args?, options?)` | Emits `SCHEDULE_ACTIVITY_TASK` with deterministic IDs. |
| `activities.cancel(activityId, options?)` | Requests cancellation for a scheduled activity. |
| `timers.start(options)` / `timers.cancel(timerId, options?)` | Manages timers with deterministic IDs. |
| `childWorkflows.start(type, args?, options?)` | Starts a child workflow execution. |
| `signals.signal(name, args?, options?)` | Sends a signal to another execution. |
| `signals.on/waitFor/drain(handle)` | Consumes inbound signals deterministically, returning payload + metadata. |
| `signals.requestCancel(workflowId, options?)` | Sends `RequestCancelExternalWorkflowExecution`. |
| `queries.register(handle, resolver)` / `queries.resolve(handle, input?, metadata?)` | Registers and evaluates workflow queries. |
| `updates.register(definition, handler, options?)` | Registers update handlers; `registerDefault` catches unmatched updates. |
| `determinism.now/random/sideEffect/getVersion/patched/deprecatePatch/localActivity` | Determinism helpers that record markers and enforce replay safety. |
| `upsertSearchAttributes(attributes)` / `upsertMemo(memo)` | Emits modify commands for search attributes or memo. |
| `cancelWorkflow(details?)` | Queues `CANCEL_WORKFLOW_EXECUTION`. |
| `continueAsNew(options?)` | Emits `CONTINUE_AS_NEW_WORKFLOW_EXECUTION` and throws `ContinueAsNewWorkflowError` to short-circuit the handler. |

### Determinism and workflow errors

- `WorkflowNondeterminismError` reports mismatched commands, random values, or timestamps. The error includes mismatch metadata and sticky cache hints.
- `WorkflowBlockedError` signals that the workflow must yield (activity pending, signal not delivered, etc.).
- `WorkflowQueryViolationError` is thrown when queries mutate workflow state.
- `ContinueAsNewWorkflowError` is thrown internally to transition to the new run.
- `WorkflowQueryHandlerMissingError` is raised when `queries.resolve` is invoked without a registered handler.

## Activity toolkit

Activities are plain async functions. Use `currentActivityContext()` to heartbeat progress, inspect metadata, or detect cancellation.

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

### Activity template example

```ts title="workers/activities.ts"
export type Activities = {
  echo(input: { message: string }): Promise<string>
  sleep(milliseconds: number): Promise<void>
}

export const echo: Activities['echo'] = async ({ message }) => {
  return message
}

export const sleep: Activities['sleep'] = async (milliseconds) => {
  await Bun.sleep(milliseconds)
}
```

### Activity lifecycle notes

- `activityContext.heartbeat(...details)` is throttled by `TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS` and retried with exponential backoff (tunable via `TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS`) so transient RPC failures do not kill the attempt.
- The latest heartbeat payload flows into cancellation/failure responses so Temporal UI surfaces helpful metadata.
- WorkerRuntime honors workflow `retry` policies locally (`maximumAttempts`, `initialInterval`, `maximumInterval`, `backoffCoefficient`, `nonRetryableErrorTypes`) before reporting terminal failures.
- Activity attempts that exhaust the policy are reported as non-retryable so the Temporal service does not perform redundant retries.

## Worker runtime and layers

### createWorker / runWorker

`createWorker` wires configuration, workflow discovery, activity registration, and optional deployment metadata. It returns a `BunWorker` handle plus the underlying `WorkerRuntime`.

```ts
import { fileURLToPath } from 'node:url'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'
import * as activities from './activities/index.ts'

const { worker, config } = await createWorker({
  activities,
  workflowsPath: fileURLToPath(new URL('./workflows/index.ts', import.meta.url)),
  taskQueue: 'payments-worker',
  namespace: 'payments',
  deployment: { name: 'payments', versioningMode: 1 },
})

await worker.run()
```

`runWorker(options?)` is a convenience helper that creates the worker and immediately starts pollers.

#### Worker entry point with graceful shutdown

```ts title="worker.ts"
import { fileURLToPath } from 'node:url'
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'
import * as activities from './workers/activities.ts'

const { worker } = await createWorker({
  activities,
  workflowsPath: fileURLToPath(new URL('./workers/workflows/index.ts', import.meta.url)),
})

const shutdown = async (signal: string) => {
  console.log(`Received ${signal}. Shutting down worker…`)
  await worker.shutdown()
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await worker.run()
```

### CreateWorkerOptions

| Option | Description |
| --- | --- |
| `config` | Pre-resolved `TemporalConfig` (skips env loading). |
| `taskQueue`, `namespace` | Overrides for the task queue or namespace. |
| `workflowsPath` | Path to a module exporting a default or named `workflows` array. |
| `workflows` | Preloaded workflow definitions (bypasses `workflowsPath`). |
| `activities` | Record of activity handlers. |
| `dataConverter` | Custom payload converter shared with the runtime. |
| `identity` | Worker identity override. |
| `deployment` | `WorkerDeploymentConfig` (name, buildId, versioning mode/behavior). |

If `deployment.versioningMode` is `WorkerVersioningMode.VERSIONED`, the runtime probes capability and registers `workerBuildId` via `UpdateWorkerBuildIdCompatibility` before pollers start.

### WorkerRuntimeOptions

Use these options with `WorkerRuntime.create`, `makeWorkerRuntimeEffect`, `runWorkerEffect`, or `createWorkerRuntimeLayer`.

| Option | Description |
| --- | --- |
| `workflowsPath`, `workflows`, `activities` | Same as `CreateWorkerOptions`. |
| `taskQueue`, `namespace`, `identity`, `config` | Overrides for runtime metadata. |
| `workflowService` | Inject an existing WorkflowService client. |
| `logger`, `metrics`, `metricsExporter` | Override observability sinks. |
| `dataConverter` | Custom payload converter. |
| `concurrency` | `{ workflow?: number; activity?: number }`. |
| `pollers` | `{ workflow?: number }` to decouple poller count from concurrency. |
| `stickyCache` | `{ size?: number; ttlMs?: number }` or a prebuilt sticky cache instance. |
| `stickyScheduling` | Force-enable or disable sticky scheduling. |
| `deployment` | `WorkerDeploymentConfig`. |
| `schedulerHooks` | Observability hooks for custom schedulers. |

### Effect-powered workers

```ts
import { Effect } from 'effect'
import {
  createWorkerRuntimeLayer,
  WorkerRuntimeService,
  WorkerRuntimeFailureSignal,
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

`WorkerService` (from `@proompteng/temporal-bun-sdk/worker`) exposes `scoped`, `with`, and accessor helpers that wrap `createWorker` in an Effect service:

```ts
import { Effect } from 'effect'
import { WorkerService } from '@proompteng/temporal-bun-sdk/worker'
import * as activities from './activities/index.ts'

await Effect.runPromise(
  WorkerService.scoped({
    activities,
    workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
  }).pipe(
    Effect.flatMap(({ run }) => run),
  ),
)
```

### Worker app helpers and CLI binary

`createWorkerAppLayer` composes config, observability, workflow service, and worker runtime layers. `runWorkerApp(options?)` boots the worker inside `Effect.scoped`, returning an effect that resolves when the worker stops. The `temporal-bun-worker` binary simply calls `runWorkerApp` with discovered workflows and activities, so you can ship a worker without writing a custom entry point:

```bash
bunx temporal-bun-worker
```

Override defaults via the same environment variables documented earlier.

## Start and manage workflows from Bun

Use `createTemporalClient()` inside scripts or services to launch, signal, query, and terminate workflows with shared retry and telemetry behavior.

```ts title="scripts/start-workflow.ts"
import { createTemporalClient } from '@proompteng/temporal-bun-sdk'

const { client } = await createTemporalClient()

const start = await client.startWorkflow({
  workflowId: `hello-${Date.now()}`,
  workflowType: 'helloWorkflow',
  taskQueue: 'prix',
  args: ['Proompteng'],
})

console.log('Workflow started:', start.runId)

await client.signalWorkflow(start.handle, 'complete', { ok: true })
await client.terminateWorkflow(start.handle, { reason: 'demo complete' })
await client.shutdown()
```

All workflow operations (`startWorkflow`, `signalWorkflow`, `queryWorkflow`, `terminateWorkflow`, `cancelWorkflow`, and `signalWithStart`) share the same handle structure, so you can persist it between processes without custom serialization.

## Replay workflow histories

`temporal-bun replay` ingests workflow histories—either JSON fixtures or live executions—and diffs determinism state using the same ingestion pipeline as the worker sticky cache.

- `--history-file <path>` – replay a captured history (`temporal workflow show --history --output json` or the repo fixtures).
- `--execution <workflowId/runId>` – fetch live history from the Temporal CLI or service (`--source cli|service|auto`).
- `--workflow-type`, `--namespace`, `--temporal-cli`, `--json` – override metadata, CLI binary location, and output format.
- Exit codes: `0` success, `2` nondeterminism, `1` IO/config errors.

```bash
# Replay a saved history fixture
bunx temporal-bun replay \
  --history-file packages/temporal-bun-sdk/tests/replay/fixtures/timer-workflow.json \
  --workflow-type timerWorkflow \
  --json

# Diff a live execution using the Temporal CLI harness
TEMPORAL_ADDRESS=127.0.0.1:7233 TEMPORAL_NAMESPACE=temporal-bun-integration \
  bunx temporal-bun replay \
  --execution workflow-id/run-id \
  --workflow-type integrationWorkflow \
  --namespace temporal-bun-integration \
  --source cli
```

Set `TEMPORAL_CLI_PATH` or pass `--temporal-cli` when the CLI is not on `PATH`. Use `--source service` to force WorkflowService RPCs in environments where the CLI is unavailable.

## CLI and tooling

### temporal-bun commands

| Command | Purpose | Key flags |
| --- | --- | --- |
| `temporal-bun init [directory]` | Scaffold a Bun worker project with workflows, activities, Dockerfile, and scripts. | `--force` overwrites files. |
| `temporal-bun doctor` | Loads config, spins up logging + metrics, writes a success summary. | `--log-format`, `--log-level`, `--metrics`, `--metrics-exporter`, `--metrics-endpoint`. |
| `temporal-bun docker-build` | Runs `docker build` with sensible defaults. | `--tag`, `--context`, `--file`. |
| `temporal-bun replay` | Replays workflow histories to detect nondeterminism. | `--history-file`, `--execution`, `--workflow-type`, `--namespace`, `--temporal-cli`, `--source cli|service|auto`, `--json`. |
| `temporal-bun help` | Prints usage and flag descriptions. | — |

Examples:

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

Wrap any Effect program with `runTemporalCliEffect` to automatically provision config, observability, and WorkflowService layers inside CLI scripts.

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

## Native bridge status

The pure TypeScript runtime is the default (and only) supported execution path. Historical Zig bridge assets remain in `packages/temporal-bun-sdk/bruke/` for posterity, but flags such as `TEMPORAL_BUN_SDK_USE_ZIG` are no longer wired into the worker or client. Future experiments should introduce new, explicit configuration rather than reviving the retired bridge.

## Local development and production tips

- Use Bun’s `--watch` flag (`bun run --watch worker.ts`) to restart workers on source changes.
- Keep activities free of Temporal SDK imports so they stay tree-shakeable and easy to unit-test.
- Expose Prometheus metrics via the worker runtime and forward them to your observability stack.
- Prefer Temporal schedules over cron for recurring workloads.
- Store long-lived credentials in a secrets manager and inject them via environment variables.

## Architecture overview

- **Workflow runtime** – executes deterministic workflows entirely inside Bun using Effect fibers. Command intents (activities, timers, child workflows, signals, continue-as-new) emit Temporal protobufs directly and are tracked in determinism snapshots.
- **Worker runtime** – wraps pollers, sticky cache routing, activity execution, and build ID registration. It honors `TEMPORAL_WORKFLOW_CONCURRENCY`, `TEMPORAL_ACTIVITY_CONCURRENCY`, sticky cache knobs, and worker versioning settings.
- **Client** – a Connect transport with branded call options, memo/search helpers, TLS diagnostics, and retries derived from environment variables. Every RPC runs through logging/metrics interceptors for observability parity with the worker runtime.
- **CLI & tooling** – `temporal-bun` provides scaffolding, connectivity checks, Docker helpers, and deterministic replay while sharing the same layers and config loader as workers.

## Tutorials & recipes

Follow the quickstart to scaffold workflows/activities, then explore `packages/temporal-bun-sdk-example` for:

- Activity heartbeats and cancellation propagation via `activityContext.heartbeat()` and `activityContext.signal.aborted`.
- Timer, signal, and child workflow orchestration using `proxyActivities` + `defineWorkflow`.
- Determinism helpers (`determinism.now`, `determinism.random`) that make replay diagnostics straightforward.

## CLI & tooling reference

See the command table above for quick reminders. Proto regeneration lives under `packages/temporal-bun-sdk/scripts/update-temporal-protos.ts`; pass `--temporal-version <x.y.z>` (once implemented) to align with upstream Temporal drops and run it before publishing new SDK versions.

## Integration harness

The integration harness wraps the Temporal CLI dev server scripts so you can execute workflows end-to-end from Bun tests.

1. Install the [Temporal CLI](https://github.com/temporalio/cli) and ensure the `temporal` binary is on your `PATH` (or set `TEMPORAL_CLI_PATH`).
2. Start the dev server with `bun scripts/start-temporal-cli.ts` or let the harness do it for you.
3. Run the suite:

```bash
bun test tests/integration/history-replay.test.ts
```

If the CLI is missing, tests log a skip and continue so the rest of the suite still passes. The harness lives in `tests/integration/harness.ts` and exposes helpers for bespoke scenarios if you need to extend coverage.

## Worker load & performance tests

The TBS-003 load harness under `tests/integration/load/**` uses CPU-heavy workflows, IO-heavy activities, and the file metrics exporter to guard throughput, poll latency, and sticky cache hit ratios. Two entry points:

1. **Bun test suite** (reuses the Temporal CLI harness):

```bash
TEMPORAL_INTEGRATION_TESTS=1 pnpm --filter @proompteng/temporal-bun-sdk exec bun test tests/integration/worker-load.test.ts
```

2. **Developer-friendly CLI runner** (wraps the same scenario without `bun test`):

```bash
pnpm --filter @proompteng/temporal-bun-sdk run test:load
```

Both commands start the Temporal CLI dev server (unless `TEMPORAL_TEST_SERVER=1` is set), run the load scenario, and write artifacts to `.artifacts/worker-load/` (`metrics.jsonl`, `report.json`, `temporal-cli.log`).

### Tuning the load harness

Use environment variables or CLI flags (`--workflows`, `--workflow-concurrency`, `--activity-concurrency`, `--timeout`) to keep runs stable on different hardware:

- `TEMPORAL_LOAD_TEST_WORKFLOWS` – total workflows submitted.
- `TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY` / `TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY` – poller/concurrency targets.
- `TEMPORAL_LOAD_TEST_WORKFLOW_POLL_P95_MS` / `TEMPORAL_LOAD_TEST_ACTIVITY_POLL_P95_MS` – maximum allowed P95 poll latency.
- `TEMPORAL_LOAD_TEST_STICKY_MIN_RATIO` – minimum sticky cache hit ratio before the suite fails.
- `TEMPORAL_LOAD_TEST_TIMEOUT_MS` – overall completion timeout per batch.
- `TEMPORAL_LOAD_TEST_ACTIVITY_BURSTS`, `TEMPORAL_LOAD_TEST_COMPUTE_ITERATIONS`, `TEMPORAL_LOAD_TEST_ACTIVITY_DELAY_MS`, `TEMPORAL_LOAD_TEST_ACTIVITY_PAYLOAD_BYTES` – tune CPU/IO stress.

## Workflow and client option reference

### StartWorkflowOptions

| Field | Description |
| --- | --- |
| `workflowId` | Unique ID for the run (idempotency key). |
| `workflowType` | Registered workflow type name. |
| `args` | Workflow arguments (array). |
| `taskQueue`, `namespace`, `identity` | Overrides for the run. |
| `cronSchedule` | Cron expression for recurring runs. |
| `memo` | Plain object encoded via the client data converter. |
| `headers` | Header map sent with the start request. |
| `searchAttributes` | Search attribute map encoded via the client data converter. |
| `requestId` | Optional idempotency key. |
| `workflowExecutionTimeoutMs`, `workflowRunTimeoutMs`, `workflowTaskTimeoutMs` | Timeout controls. |
| `retryPolicy` | `RetryPolicyOptions` applied to the workflow. |

### SignalWithStartOptions

Extends `StartWorkflowOptions` with `signalName` and `signalArgs`.

### TerminateWorkflowOptions

| Field | Description |
| --- | --- |
| `reason` | Human-friendly reason. |
| `details` | Array of payloads encoded via the data converter. |
| `firstExecutionRunId`, `runId` | Target run controls when terminating by handle. |

### WorkflowUpdateOptions / WorkflowUpdateAwaitOptions

| Field | Description |
| --- | --- |
| `updateName` | Name registered via `defineWorkflowUpdates`. |
| `args` | Update payloads. |
| `headers` | Header map for the update RPC. |
| `updateId` | Custom update ID (defaults to auto-generated). |
| `waitForStage` | `'unspecified'`, `'admitted'`, `'accepted'`, or `'completed'`. |
| `firstExecutionRunId` | Targets the first execution when runs continue-as-new. |

### TemporalClientCallOptions

| Field | Description |
| --- | --- |
| `headers` | Request headers (string or binary values). |
| `signal` | `AbortSignal` to cancel the RPC. |
| `timeoutMs` | Per-call deadline. |
| `retryPolicy` | Partial `TemporalRpcRetryPolicy` override. |
| `queryRejectCondition` | Controls query rejection behavior. |

## Additional resources

- `packages/temporal-bun-sdk-example` — runnable Bun worker showcasing workflows, activities, tests, and Docker packaging.
- `packages/temporal-bun-sdk/tests/replay` — determinism replay fixtures used by `temporal-bun replay`.
