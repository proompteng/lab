# `@proompteng/temporal-bun-sdk`

A Bun-first Temporal SDK implemented entirely in TypeScript. It speaks gRPC over HTTP/2 using [Connect](https://connectrpc.com/) and executes workflows with the [Effect](https://effect.website/) runtime so you can run Temporal workers without shipping Node.js or any native bridge.

## Highlights
- **TypeScript-only runtime** – workflow polling, activity execution, and command generation run in Bun using generated Temporal protobuf stubs.
- **Effect-based workflows** – define deterministic workflows with `Effect` and let the runtime translate results/failures into Temporal commands.
- **Connect-powered client** – `createTemporalClient` gives you a fully typed Temporal WorkflowService client backed by @bufbuild/protobuf.
- **Simple data conversion** – JSON payload conversion out of the box with hooks for custom codecs.
- **Bun CLI** – `temporal-bun` scaffolds workers and ships lightweight Docker helpers (no Zig build steps required).

## Prerequisites
- **Bun ≥ 1.1.20** – required for the runtime and CLI.
- **Temporal CLI ≥ 1.4** – optional, but useful for spinning up a local dev server.

## Quickstart
1. **Install dependencies**
   ```bash
   bun install
   ```

2. **Configure Temporal access**
   Create an `.env` (or export variables in your shell) with the connection details. `loadTemporalConfig` reads these at runtime:
   ```env
   TEMPORAL_ADDRESS=temporal.example.com:7233
   TEMPORAL_NAMESPACE=default
   TEMPORAL_API_KEY=temporal-cloud-api-key-123      # optional
   TEMPORAL_TLS_CA_PATH=certs/cloud-ca.pem          # optional – enable TLS
   TEMPORAL_TLS_CERT_PATH=certs/worker.crt          # optional – only for mTLS
   TEMPORAL_TLS_KEY_PATH=certs/worker.key           # optional – only for mTLS
   TEMPORAL_TLS_SERVER_NAME=temporal.example.com    # optional – SNI override
   TEMPORAL_TASK_QUEUE=prix
   TEMPORAL_STICKY_CACHE_SIZE=256                   # optional – determinism cache capacity
   TEMPORAL_STICKY_CACHE_TTL_MS=300000              # optional – eviction TTL in ms
   TEMPORAL_STICKY_QUEUE_TIMEOUT_MS=10000           # optional – sticky task queue timeout
   ```

   > Running against `temporal server start-dev`? Omit TLS variables and set `TEMPORAL_ADDRESS=127.0.0.1:7233`. Set `TEMPORAL_ALLOW_INSECURE=1` when testing with self-signed certificates.

3. **Build the SDK once**
   ```bash
   bun run build
   ```

4. **Run the Bun worker**
   ```bash
   # optional: in another shell
   bun scripts/start-temporal-cli.ts

   # run the worker
   bun run start:worker
   ```

5. **Scaffold a new worker project**
   ```bash
   temporal-bun init hello-worker
   ```

## Observability

The SDK now ships structured logging, metrics, and optional tracing hooks. Defaults target local development with JSON logs and an in-memory metrics registry, but everything can be overridden via configuration or custom sinks.

### Environment variables

`loadTemporalConfig()` understands the following observability-specific variables:

| Variable | Description | Default |
| --- | --- | --- |
| `TEMPORAL_LOG_LEVEL` | Minimum log level (`debug`, `info`, `warn`, `error`). | `info` |
| `TEMPORAL_LOG_FORMAT` | Console format (`json` or `pretty`). | `json` |
| `TEMPORAL_METRICS_EXPORTER` | Metrics backend (`in-memory` or `otel`). | `in-memory` |
| `TEMPORAL_METRICS_METER_NAME` | Meter name when using OTEL. | `temporal-bun-sdk` |
| `TEMPORAL_METRICS_METER_VERSION` | Optional meter version string. | *(unset)* |
| `TEMPORAL_METRICS_SCHEMA_URL` | OTEL schema URL if required. | *(unset)* |
| `TEMPORAL_TRACING_ENABLED` | Enable tracing span emission (`1`, `true`). | `false` |
| `TEMPORAL_TRACING_EXPORTER` | Tracing exporter (`otel` or `none`). | `none` |
| `TEMPORAL_TRACING_SERVICE_NAME` | Service name reported to the tracer. | `temporal-bun-sdk` |

### Worker runtime metrics

When you run the Bun worker you'll receive the following time-series by default (attribute labels omitted for brevity):

- `temporal_worker_poll_latency_ms` (histogram) – latency for workflow/activity polls.
- `temporal_worker_task_failures_total` – workflow/activity failures grouped by cause.
- `temporal_worker_task_retry_attempts_total` – retry counts observed for workflow/activity tasks.
- `temporal_worker_sticky_cache_events_total` – sticky-cache hit/miss/store/evict events.

### Temporal client metrics

The Connect client now emits:

- `temporal_client_rpc_latency_ms` (histogram) – WorkflowService RPC latency.
- `temporal_client_rpc_failures_total` – RPC failures grouped by method and error code.

### Custom sinks

Pass observability services into the runtime constructors to plug in your own ecosystem tooling:

```ts
import { createLogger } from '@proompteng/temporal-bun-sdk/observability/logger'
import { makeOpenTelemetryMetrics } from '@proompteng/temporal-bun-sdk/observability/metrics'
import { makeOpenTelemetryTracer } from '@proompteng/temporal-bun-sdk/observability/tracing'

const logger = createLogger({
  level: 'debug',
  sinks: [
    {
      write: (record) => Effect.sync(() => lokiStream.write(JSON.stringify(record))),
    },
  ],
})

const metrics = makeOpenTelemetryMetrics(meter) // meter from @opentelemetry/api
const tracer = makeOpenTelemetryTracer({ serviceName: 'my-service' })

const worker = await WorkerRuntime.create({
  logger,
  metrics,
  tracer,
  // ...
})
```

`createTemporalClient` accepts the same overrides so you can share telemetry wiring across workers and auxiliary services.

## Workflow surface

Workflow handlers receive a rich context that captures command intents deterministically. Alongside `input` you now get:

- `activities.schedule(type, args, options)` – buffers a `SCHEDULE_ACTIVITY_TASK` command. Activity IDs default to `activity-{n}` and inherit the workflow task queue unless overridden.
- `timers.start({ timeoutMs })` – emits a `START_TIMER` command and returns a handle for bookkeeping.
- `childWorkflows.start(type, args, options)` – records `START_CHILD_WORKFLOW_EXECUTION` with optional `workflowId`, retry policy, and task queue overrides.
- `signals.signal(name, args, options)` – queues `SIGNAL_EXTERNAL_WORKFLOW_EXECUTION` for another run or child.
- `continueAsNew(options)` – records a `CONTINUE_AS_NEW_WORKFLOW_EXECUTION` command and short-circuits the current run.
- `determinism.now()` / `determinism.random()` – shims for wall clock time and randomness that log values into the replay ledger so replays must produce identical sequences.

Example:

```ts
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'
import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'

export const workflows = [
  defineWorkflow('greet', Schema.Array(Schema.String), ({ input, activities, timers, determinism }) => {
    const [name = 'Temporal'] = input
    return Effect.flatMap(activities.schedule('recordGreeting', [name]), () =>
      Effect.flatMap(timers.start({ timeoutMs: 1_000 }), () =>
        Effect.sync(() => {
          const iso = new Date(determinism.now()).toISOString()
          return `Greeting enqueued for ${name} at ${iso}`
        }),
      ),
    )
  }),
]
```

On each workflow task the executor compares newly emitted intents, random values, and logical timestamps against the stored determinism state. Mismatches raise `WorkflowNondeterminismError` and cause the worker to fail the task with `WORKFLOW_TASK_FAILED_CAUSE_NON_DETERMINISTIC_ERROR`, mirroring Temporal’s official SDK behavior. Determinism snapshots are recorded as `temporal-bun-sdk/determinism` markers in workflow history and optionally cached via a sticky determinism cache. Tune cache behaviour with `TEMPORAL_STICKY_CACHE_SIZE`, `TEMPORAL_STICKY_CACHE_TTL_MS`, and `TEMPORAL_STICKY_QUEUE_TIMEOUT_MS`. You can temporarily revert to the legacy “complete or fail only” mode by setting `TEMPORAL_DISABLE_WORKFLOW_CONTEXT=1`.

## Integration harness

The SDK ships an integration harness that wraps the Temporal CLI dev server scripts. It can execute workflows through `temporal workflow execute`/`temporal workflow show`, turn the emitted history into `HistoryEvent[]`, and feed the ingestion pipeline. To use it locally:

1. Install the [Temporal CLI](https://github.com/temporalio/cli) and ensure the `temporal` binary is on your `PATH` (or set `TEMPORAL_CLI_PATH`).
2. Start the dev server with `bun scripts/start-temporal-cli.ts` or let the harness do it for you.
3. Run the integration suite:
   ```bash
   bun test tests/integration/history-replay.test.ts
   ```

If the CLI is missing the tests log a skip and continue so the rest of the suite still passes. The harness lives in `tests/integration/harness.ts` and exposes helpers for bespoke scenarios if you need to extend coverage.

## Effect service integration

```ts
import { Effect, Layer } from 'effect'
import { WorkerService } from '@proompteng/temporal-bun-sdk/worker'

const workerLayer = WorkerService({
  workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
})

const program = Effect.gen(function* () {
  const { run } = yield* WorkerService
  yield* run
})

await Effect.provide(program, workerLayer)
```

Define workflows with the Effect runtime:

```ts
import { Effect } from 'effect'
import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'

export const workflows = [
  defineWorkflow('helloWorkflow', ({ input }) =>
    Effect.sync(() => {
      const [name] = Array.isArray(input) ? input : []
      return typeof name === 'string' && name.length > 0 ? `Hello, ${name}!` : 'Hello, Temporal!'
    }),
  ),
]
```

Point the worker at a module exporting either `workflows` or a default array of definitions. Activity handlers remain plain async functions:

```ts
import { createWorker } from '@proompteng/temporal-bun-sdk/worker'
import * as activities from './activities'

const { worker } = await createWorker({
  activities,
  workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
})

await worker.run()
```

## CLI commands
```
temporal-bun init [directory]        Scaffold a new worker project
temporal-bun docker-build            Build a Docker image for the current project
temporal-bun help                    Show available commands
```

## Data conversion
`createDefaultDataConverter()` encodes payloads as JSON. Implement `DataConverter` if you need a custom codec or encryption layer:

```ts
import { createDefaultDataConverter } from '@proompteng/temporal-bun-sdk/common/payloads'

const dataConverter = createDefaultDataConverter()
```

Pass your converter to both the worker and client factories to keep payload handling consistent.

## License
MIT © Proompt Engineering
