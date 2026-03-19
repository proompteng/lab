# `@proompteng/temporal-bun-sdk`

Run Temporal workers and clients on Bun with replay tooling, Docker helpers, and Temporal Cloud/TLS support. The SDK is implemented entirely in TypeScript, speaks gRPC over HTTP/2 using [Connect](https://connectrpc.com/), and executes workflows with the [Effect](https://effect.website/) runtime so you can avoid a native bridge.

Full docs: <https://docs.proompteng.ai/docs/temporal-bun-sdk>

## Fastest start

Use this path if you want a working Bun worker as quickly as possible.

1. Scaffold a new project in a clean directory:

   ```bash
   cd /tmp
   bunx @proompteng/temporal-bun-sdk init hello-worker
   cd hello-worker
   ```

2. Repair the generated SDK version for the current npm release:

   ```bash
   bun add @proompteng/temporal-bun-sdk@0.7.0
   ```

3. Start Temporal locally:

   ```bash
   temporal server start-dev --headless
   ```

4. Create a `.env` file:

   ```env
   TEMPORAL_ADDRESS=127.0.0.1:7233
   TEMPORAL_NAMESPACE=default
   TEMPORAL_TASK_QUEUE=hello-bun
   ```

5. Run the worker:

   ```bash
   bun run dev
   ```

6. In another shell, start the example workflow:

   ```bash
   temporal workflow start \
     --task-queue hello-bun \
     --workflow-type helloWorkflow \
     --input '"Codex"'
   ```

You should see the worker pick up the workflow and complete it.

## Install into an existing Bun project

```bash
bun add @proompteng/temporal-bun-sdk
```

For Temporal Cloud, TLS, Docker, replay, and observability, use the full guide:
<https://docs.proompteng.ai/docs/temporal-bun-sdk>

## Why teams adopt it

- **Bun-native runtime** – run workers, activities, and clients directly on Bun.
- **Production path included** – TLS, Temporal Cloud, Docker packaging, retries, observability, and replay tooling are built in.
- **Typed workflow surface** – workflows, queries, updates, signals, schedules, and Cloud/Operator RPCs are exposed with typed helpers.
- **No native bridge required** – the runtime is pure TypeScript and uses generated protobuf stubs.
- **CLI included** – `temporal-bun` scaffolds workers, validates config with `doctor`, builds Docker images, and replays histories.

## Prerequisites

- **Bun ≥ 1.3.10** – required for the runtime and CLI.
- **Temporal CLI ≥ 1.4** – optional, but useful for spinning up a local dev server.

## Production features

- `loadTemporalConfig()` with typed env parsing for local, self-hosted, and Temporal Cloud setups.
- TLS, API key, and insecure-dev toggles with early configuration validation.
- `temporal-bun doctor` to validate config and exporters before rollout.
- Replay tooling to verify determinism against stored histories.
- Docker helpers for Bun worker packaging.
- Testing helpers for local and time-skipping environments.
- Observability hooks for logs, metrics, tracing, and interceptors.

## Useful links

- Docs: <https://docs.proompteng.ai/docs/temporal-bun-sdk>
- Example app: <https://github.com/proompteng/lab/tree/main/packages/temporal-bun-sdk-example>
- Package issues: <https://github.com/proompteng/lab/issues>

## Workflow updates

### Registering update handlers

Workflows can now declare strongly typed update handlers with the new `defineWorkflowUpdates` helper and register them inside the workflow definition. Update handlers run inside the normal determinism guard and support optional Effect Schema validators:

```ts
import { defineWorkflow, defineWorkflowUpdates } from '@proompteng/temporal-bun-sdk/workflow'
import * as Schema from 'effect/Schema'

const counterUpdates = defineWorkflowUpdates([
  {
    name: 'setCounter',
    input: Schema.Number,
    handler: async ({ updates }, value: number) => updates.registerDefault(async () => value),
  },
])

export const counterWorkflow = defineWorkflow(
  'counterWorkflow',
  Schema.Number,
  ({ input, updates }) => {
    let count = input

    updates.register(counterUpdates[0], async (_ctx, value) => {
      count = value
      return count
    })

    return Effect.sync(() => count)
  },
  { updates: counterUpdates },
)
```

The workflow runtime automatically polls `PollWorkflowTaskQueueResponse.messages`, routes update requests through the scheduler, and records lifecycle events (admitted/accepted/completed) in determinism snapshots so sticky caches stay healthy on replay.

## Workflow queries

- Register query handlers with `defineWorkflowQueries` and wire them inside the workflow handler. The worker runtime now detects legacy query-only tasks (`response.query`) and answers them via `RespondQueryTaskCompleted`, so CLI/SDK queries return immediately even when workflow tasks are blocked.
- Query evaluation runs in a **read-only** mode: no new commands, timers, randomness, or continue-as-new requests are allowed. Violations surface as `WorkflowQueryViolationError` and are returned to the caller.
- The client supports `QueryRejectCondition` through `temporalCallOptions({ queryRejectCondition: QueryRejectCondition.NOT_OPEN })`; query results are decoded with the configured data converter.
- Metrics: `temporal_worker_query_started_total`, `temporal_worker_query_completed_total`, `temporal_worker_query_failed_total`, and latency histogram `temporal_worker_query_latency_ms`.

```ts
import { defineWorkflow, defineWorkflowQueries } from '@proompteng/temporal-bun-sdk/workflow'
import { QueryRejectCondition, temporalCallOptions } from '@proompteng/temporal-bun-sdk/client'

const queries = defineWorkflowQueries({
  status: {
    input: Schema.Struct({}),
    output: Schema.String,
  },
})

export const statusWorkflow = defineWorkflow({
  name: 'statusWorkflow',
  queries,
  handler: ({ queries: registry }) =>
    Effect.gen(function* () {
      let current = 'booting'
      yield* registry.register(queries.status, () => Effect.sync(() => current))
      current = 'ready'
      return current
    }),
})

// client side
const value = await client.queryWorkflow(
  handle,
  'status',
  temporalCallOptions({
    queryRejectCondition: QueryRejectCondition.NONE,
  }),
)
```

### Invoking workflow updates

The client surface exposes `workflow.update`, `workflow.awaitUpdate`, `workflow.cancelUpdate`, and `workflow.getUpdateHandle` helpers on the `TemporalWorkflowClient`:

```ts
const updateResult = await client.workflow.update(handle, {
  updateName: 'setCounter',
  args: [42],
  waitForStage: 'completed', // 'admitted' | 'accepted' | 'completed'
})

if (updateResult.outcome?.status === 'success') {
  console.log('Counter set to', updateResult.outcome.result)
}

// await a handle later, perhaps from another service
const handle = client.workflow.getUpdateHandle(handle, updateResult.handle.updateId)
// defaults to waiting for completion when waitForStage is omitted
await client.workflow.awaitUpdate(handle)
```

Each update call is idempotent (via `updateId`) and accepts the same `temporalCallOptions` as other Workflow APIs so you can override headers, retries, or timeouts per request.

## WorkflowService client resilience

`createTemporalClient()` now includes built-in resilience features:

- **Configurable retries** – `loadTemporalConfig()` populates `config.rpcRetryPolicy` from the `TEMPORAL_CLIENT_RETRY_*` env vars (or from defaults). Every WorkflowService RPC is wrapped in `withTemporalRetry()` (decorrelated jitter + exponential backoff). Override per-call values with the new `TemporalClientCallOptions.retryPolicy` field when you need a bespoke attempt budget.
- **Optional call options on every method** – `startWorkflow`, `signalWorkflow`, `queryWorkflow`, `signalWithStart`, `terminateWorkflow`, and `describeNamespace` accept an optional trailing `callOptions` argument. Wrap them with `temporalCallOptions()` so payload objects are never mistaken for options:

  ```ts
  import { temporalCallOptions } from '@proompteng/temporal-bun-sdk'

  await client.queryWorkflow(
    handle,
    'currentState',
    { kind: 'snapshot' },
    temporalCallOptions({
      timeoutMs: 15_000,
      headers: { 'x-trace-id': traceId },
    }),
  )
  ```

- **Telemetry-friendly interceptors** – the default interceptor builder injects namespace/identity headers, logs RPC attempts, and records latency/error counters with your configured metrics registry/exporter. Provide `interceptors` when creating a client to append custom tracing or auth middleware.
- **Memo & search attribute helpers** – `client.memo.encode/decode` and `client.searchAttributes.encode/decode` reuse the client’s `DataConverter`, making it trivial to prepare `Memo`/`SearchAttributes` payloads for raw WorkflowService requests.
- **TLS validation & handshake errors** – TLS buffers are validated up front (missing files, invalid PEMs, and mismatched cert/key pairs throw `TemporalTlsConfigurationError`). Runtime handshake failures raise `TemporalTlsHandshakeError` with remediation hints (verify CA bundles, check `TEMPORAL_TLS_SERVER_NAME`, or use `TEMPORAL_ALLOW_INSECURE=1` in trusted dev clusters).

## Workflow surface

Workflow handlers receive a rich context that captures command intents deterministically. Alongside `input` you now get:

- `activities.schedule(type, args, options)` – buffers a `SCHEDULE_ACTIVITY_TASK` command. Activity IDs default to `activity-{n}` and inherit the workflow task queue unless overridden.
- `timers.start({ timeoutMs })` – emits a `START_TIMER` command and returns a handle for bookkeeping.
- `childWorkflows.start(type, args, options)` – records `START_CHILD_WORKFLOW_EXECUTION` with optional `workflowId`, retry policy, and task queue overrides.
- `signals.signal(name, args, options)` – queues `SIGNAL_EXTERNAL_WORKFLOW_EXECUTION` for another run or child.
- `signals.on(handle, handler)` – consumes the next delivery for `handle` and runs `handler` with the decoded payload + metadata (throws `WorkflowBlockedError` when history hasn’t delivered the signal yet).
- `signals.waitFor(handle)` / `signals.drain(handle)` – await a single or all buffered deliveries for a handle and return the decoded payload plus the originating history metadata (event id, workflow task completion id, and identity).
- `continueAsNew(options)` – records a `CONTINUE_AS_NEW_WORKFLOW_EXECUTION` command and short-circuits the current run.
- `determinism.now()` / `determinism.random()` – shims for wall clock time and randomness that log values into the replay ledger so replays must produce identical sequences.
- `queries.register(handle, resolver)` – exposes a deterministic query handler that the worker will invoke whenever Temporal issues a query task; handlers run under the determinism guard and must not mutate workflow state.
- `queries.resolve(handle, input)` – synchronously evaluate a registered query inside the workflow (useful for composing queries from smaller resolvers or for unit tests).

Signals and queries declare their schema via helper builders so handlers operate on typed payloads. The object form of `defineWorkflow` accepts the handle sets and surfaces them from the workflow definition for reuse:

```ts
const signals = defineWorkflowSignals({
  unblock: Schema.String,
  finish: Schema.Struct({}),
})
const queries = defineWorkflowQueries({
  state: {
    input: Schema.Struct({}),
    output: Schema.Struct({ message: Schema.String }),
  },
})

export const signalDrivenWorkflow = defineWorkflow({
  name: 'signalDrivenWorkflow',
  signals,
  queries,
  handler: ({ signals, queries }) =>
    Effect.gen(function* () {
      let current = 'waiting'
      yield* queries.register(queries.state, () => Effect.sync(() => ({ message: current })))
      const delivery = yield* signals.waitFor(signals.unblock)
      current = delivery.payload
      yield* signals.waitFor(signals.finish)
      return current
    }),
})
```

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

On each workflow task the executor compares newly emitted intents, random values, and logical timestamps against the stored determinism state. Mismatches raise `WorkflowNondeterminismError` and cause the worker to fail the task with `WORKFLOW_TASK_FAILED_CAUSE_NON_DETERMINISTIC_ERROR`, mirroring Temporal’s official SDK behavior. Determinism snapshots are recorded as `temporal-bun-sdk/determinism` markers in workflow history and optionally cached via a sticky determinism cache. When replaying, the SDK applies the latest marker and then replays any trailing history events so late signals, cancels, and updates are still represented. You can throttle or switch to delta markers via `TEMPORAL_DETERMINISM_MARKER_*` while tuning cache behaviour with `TEMPORAL_STICKY_CACHE_SIZE` and `TEMPORAL_STICKY_TTL_MS`; the sticky worker queue inherits its schedule-to-start timeout from the TTL value.

## Activity lifecycle

Activities run with an ambient `ActivityContext` (available through `currentActivityContext()`) so you can send heartbeats, observe cancellation, and inspect attempt metadata:

```ts
import { currentActivityContext } from '@proompteng/temporal-bun-sdk/worker'

export const ingestLargeFile = async (chunks: Iterable<string>) => {
  const ctx = currentActivityContext()
  let processed = 0
  for (const chunk of chunks) {
    // do expensive work
    await writeChunk(chunk)
    processed += 1
    await ctx?.heartbeat({ processed })
    ctx?.throwIfCancelled()
  }
  return processed
}
```

- `activityContext.heartbeat(...details)` is throttled by `TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS` and retried with exponential backoff (tunable via `TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS`) so transient RPC failures do not kill the attempt.
- The latest heartbeat payload automatically flows into cancellation/failure responses so Temporal UI surfaces helpful metadata.
- WorkerRuntime honours workflow `retry` policies locally: `maximumAttempts`, `initialInterval`, `maximumInterval`, `backoffCoefficient`, and `nonRetryableErrorTypes` all apply before a terminal failure is reported back to the server. Errors flagged as non-retryable (`error.nonRetryable = true` or matching the configured type list) short-circuit the retry loop.
- Activity attempts that exhaust the policy are reported as `nonRetryable` failures so the Temporal service does not perform redundant retries.

## Integration harness

The SDK ships an integration harness that wraps the Temporal CLI dev server scripts. It can execute workflows through `temporal workflow execute`/`temporal workflow show`, turn the emitted history into `HistoryEvent[]`, and feed the ingestion pipeline. To use it locally:

1. Install the [Temporal CLI](https://github.com/temporalio/cli) and ensure the `temporal` binary is on your `PATH` (or set `TEMPORAL_CLI_PATH`).
2. Start the dev server with `bun scripts/start-temporal-cli.ts` or let the harness do it for you.
3. Run the integration suite:
   ```bash
   bun test tests/integration/history-replay.test.ts
   ```

If the CLI is missing the tests log a skip and continue so the rest of the suite still passes. The harness lives in `tests/integration/harness.ts` and exposes helpers for bespoke scenarios if you need to extend coverage.

## Worker load & performance tests

The TBS-003 load harness lives under `tests/integration/load/**` and uses CPU-heavy workflows, I/O-heavy activities, and the worker runtime's file metrics exporter to guard throughput, poll latency, and sticky cache hit ratios. There are two supported entry points:

1. **Bun test suite** (reuses the Temporal CLI harness):
   ```bash
   cd packages/temporal-bun-sdk && TEMPORAL_INTEGRATION_TESTS=1 bun test tests/integration/worker-load.test.ts
   ```

````
2. **Developer-friendly CLI runner** (wraps the same scenario without `bun test`):
```bash
cd packages/temporal-bun-sdk && bun run test:load
````

Both commands start the Temporal CLI dev server (unless `TEMPORAL_TEST_SERVER=1` is set), run the worker load scenario, and write artefacts to `.artifacts/worker-load/`:

- `metrics.jsonl` – raw JSONL stream from the file metrics exporter.
- `report.json` – human-readable summary (config, peak concurrency, throughput, latency percentiles, sticky cache hit ratio).
- `temporal-cli.log` – CLI stdout/stderr captured during the run.

The default profile now submits 36 workflows (roughly a 2:1 mix of CPU-heavy to IO-heavy types) with worker poller concurrency of 10/14 (workflow/activity) and a 100-second workflow deadline. That keeps the CI run comfortably under two minutes while actually saturating the scheduler. The Bun test wrapper adds a 15-second safety buffer on top of `TEMPORAL_LOAD_TEST_TIMEOUT_MS + TEMPORAL_LOAD_TEST_METRICS_FLUSH_MS`, so keep that env var in sync with any threshold tweaks.

### Tuning the load harness

The harness is driven by env vars (also exposed as CLI flags via `--workflows`, `--workflow-concurrency`, `--activity-concurrency`, and `--timeout` when calling `bun run test:load`). Key overrides:

- `TEMPORAL_LOAD_TEST_WORKFLOWS` – total workflows to submit.
- `TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY` / `TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY` – poller counts / concurrency targets.
- `TEMPORAL_LOAD_TEST_WORKFLOW_POLL_P95_MS` / `TEMPORAL_LOAD_TEST_ACTIVITY_POLL_P95_MS` – max allowed P95 poll latency.
- `TEMPORAL_LOAD_TEST_STICKY_MIN_RATIO` – minimum sticky cache hit ratio before the suite fails.
- `TEMPORAL_LOAD_TEST_TIMEOUT_MS` – overall completion timeout per batch.
- `TEMPORAL_LOAD_TEST_ACTIVITY_BURSTS`, `TEMPORAL_LOAD_TEST_COMPUTE_ITERATIONS`, `TEMPORAL_LOAD_TEST_ACTIVITY_DELAY_MS`, `TEMPORAL_LOAD_TEST_ACTIVITY_PAYLOAD_BYTES` – fine-tune CPU/IO stress.

CI runs `cd packages/temporal-bun-sdk && bun run test:load` inside `.github/workflows/temporal-bun-sdk.yml` and uploads `.artifacts/worker-load/{metrics.jsonl,report.json,temporal-cli.log}` so reviewers can inspect regressions. When running locally on slower hardware, lower the concurrency knobs or bump the latency thresholds to avoid spurious failures.

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

### Layer-based worker bootstrap

```ts
import { runWorkerApp } from '@proompteng/temporal-bun-sdk/runtime/worker-app'
import * as activities from './activities'

await runWorkerApp({
  config: {
    defaults: {
      address: '127.0.0.1:7233',
      namespace: 'staging',
      taskQueue: 'staging-worker',
    },
  },
  worker: {
    activities,
    workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
  },
})
```

### CLI layer helpers

Use `runTemporalCliEffect` to run ad-hoc Effect programs (doctor checks, replay helpers,
tests) against the same layered config/logging/workflow stack without hand-loading env vars:

```ts
import { Effect } from 'effect'
import { runTemporalCliEffect } from '@proompteng/temporal-bun-sdk/runtime/cli-layer'
import { TemporalConfigService } from '@proompteng/temporal-bun-sdk/runtime/effect-layers'

await runTemporalCliEffect(
  Effect.gen(function* () {
    const config = yield* TemporalConfigService
    console.log('Active namespace:', config.namespace)
  }),
  {
    config: {
      defaults: {
        address: '127.0.0.1:7233',
        namespace: 'cli-layer',
        taskQueue: 'cli-layer',
      },
    },
  },
)
```

## CLI commands

```
temporal-bun init [directory]        Scaffold a new worker project
temporal-bun docker-build            Build a Docker image for the current project
temporal-bun doctor                  Validate config + observability sinks
temporal-bun replay                  Replay workflow histories and diff determinism
temporal-bun skill                   Install/list bundled agent skills
temporal-bun help                    Show available commands
```

## Bundled agent skills

`@proompteng/temporal-bun-sdk` ships with a packaged Temporal skill bundle under `skills/` plus CLI helpers:

```bash
# list available bundled skills
bunx temporal-bun skill list

# install default bundled skill into Codex skills directory
bunx temporal-bun skill install temporal

# install into a custom directory
bunx temporal-bun skill install temporal --to /tmp/my-skills
```

For direct scripting, use the exported API from `@proompteng/temporal-bun-sdk/skills`:

```ts
import { installBundledSkill, listBundledSkills } from '@proompteng/temporal-bun-sdk/skills'

const skills = await listBundledSkills()
await installBundledSkill({
  skillName: skills[0]?.name ?? 'temporal',
  destinationDir: '/tmp/skills',
  force: true,
})
```

### Replay workflow histories

`temporal-bun replay` ingests workflow histories from JSON files or live
executions, reuses the existing determinism ingestion pipeline, and exits with a
non-zero status when mismatches surface (`0` success, `2` nondeterminism, `1`
configuration or IO failures).

- **History files** – accept either raw `temporal workflow show --history --output
json` output or fixture-style envelopes containing `history` + `info`.
- **Live executions** – pass `--execution <workflowId/runId>` and the command
  shells out to the Temporal CLI (`--source cli`) or the WorkflowService RPC API
  (`--source service`). `--source auto` (default) tries the CLI first and falls
  back to WorkflowService when the binary is missing.
- **Observability** – the command composes `runTemporalCliEffect` layers (config,
  observability, WorkflowService) before running and increments
  `temporal_bun_replay_runs_total` / `temporal_bun_replay_mismatches_total`.
- **Troubleshooting** – surface the mismatching command index, event ids, and
  workflow-task metadata on stdout plus a JSON summary when `--json` is set.

Examples:

```bash
# Replay a captured history file
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

# Force WorkflowService RPCs (no CLI installed)
bunx temporal-bun replay \
  --execution workflow-id/run-id \
  --workflow-type integrationWorkflow \
  --namespace temporal-bun-integration \
  --source service
```

Set `TEMPORAL_CLI_PATH` or `--temporal-cli` if the Temporal CLI binary is not on
your `PATH`. TLS, API key, and namespace overrides rely on the same environment
variables consumed by worker/client code (`TEMPORAL_ADDRESS`,
`TEMPORAL_NAMESPACE`, `TEMPORAL_TLS_*`, etc.).

## Data conversion

`createDefaultDataConverter()` encodes payloads as JSON. Implement `DataConverter` if you need a custom codec or encryption layer:

```ts
import { createDefaultDataConverter } from '@proompteng/temporal-bun-sdk/common/payloads'

const dataConverter = createDefaultDataConverter()
```

Pass your converter to both the worker and client factories to keep payload handling consistent.

## Worker versioning and build IDs

Workers derive their build ID (in priority order) from:

1. `deployment.buildId` passed to `createWorker(...)` / `WorkerRuntime.create(...)`
2. `TEMPORAL_WORKER_BUILD_ID`
3. a derived value based on the configured `workflowsPath` contents (recommended default)

When `deployment.versioningMode` is `WorkerVersioningMode.VERSIONED`, the worker includes deployment metadata (deployment name + build ID) in poll/response requests so the server can route workflow tasks to the correct build.

The Bun SDK does not call the deprecated Build ID Compatibility APIs (Version Set-based “worker versioning v0.1”), since they may be disabled on some namespaces.

## License

MIT © ProomptEng AI
