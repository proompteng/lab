# `@proompteng/temporal-bun-sdk`

A Bun-first Temporal SDK implemented entirely in TypeScript. It speaks gRPC over HTTP/2 using [Connect](https://connectrpc.com/) and executes workflows with the [Effect](https://effect.website/) runtime so you can run Temporal workers without shipping Node.js or any native bridge.

## Highlights
- **TypeScript-only runtime** – workflow polling, activity execution, and command generation run in Bun using generated Temporal protobuf stubs.
- **Effect-based workflows** – define deterministic workflows with `Effect` and let the runtime translate results/failures into Temporal commands.
- **Connect-powered client** – `createTemporalClient` gives you a fully typed Temporal WorkflowService client backed by @bufbuild/protobuf.
- **Simple data conversion** – JSON payload conversion out of the box with hooks for custom codecs.
- **Bun CLI** – `temporal-bun` scaffolds workers and ships lightweight Docker helpers (no Zig build steps required).

## Release Notes
- Track every published version in [`packages/temporal-bun-sdk/CHANGELOG.md`](./CHANGELOG.md).

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
   TEMPORAL_CLIENT_RETRY_MAX_ATTEMPTS=5             # optional – WorkflowService RPC attempts
   TEMPORAL_CLIENT_RETRY_INITIAL_MS=200             # optional – first retry delay in ms
   TEMPORAL_CLIENT_RETRY_MAX_MS=5000                # optional – max retry delay in ms
   TEMPORAL_CLIENT_RETRY_BACKOFF=2                  # optional – exponential backoff coefficient
   TEMPORAL_CLIENT_RETRY_JITTER_FACTOR=0.2          # optional – decorrelated jitter (0-1)
   TEMPORAL_CLIENT_RETRY_STATUS_CODES=UNAVAILABLE,DEADLINE_EXCEEDED  # optional – retryable gRPC codes
   TEMPORAL_TASK_QUEUE=prix
   TEMPORAL_WORKFLOW_CONCURRENCY=4                  # optional – workflow pollers
   TEMPORAL_ACTIVITY_CONCURRENCY=4                  # optional – activity pollers
   TEMPORAL_STICKY_CACHE_SIZE=256                   # optional – determinism cache capacity
   TEMPORAL_STICKY_TTL_MS=300000                    # optional – eviction TTL in ms
   TEMPORAL_STICKY_SCHEDULING_ENABLED=1             # optional – disable to bypass sticky scheduling
   TEMPORAL_ACTIVITY_HEARTBEAT_INTERVAL_MS=4000     # optional – heartbeat throttle interval in ms
   TEMPORAL_ACTIVITY_HEARTBEAT_RPC_TIMEOUT_MS=5000  # optional – heartbeat RPC timeout in ms
   TEMPORAL_WORKER_DEPLOYMENT_NAME=prix-deploy      # optional – worker deployment metadata
   TEMPORAL_WORKER_BUILD_ID=git-sha                 # optional – build-id for versioning
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

On each workflow task the executor compares newly emitted intents, random values, and logical timestamps against the stored determinism state. Mismatches raise `WorkflowNondeterminismError` and cause the worker to fail the task with `WORKFLOW_TASK_FAILED_CAUSE_NON_DETERMINISTIC_ERROR`, mirroring Temporal’s official SDK behavior. Determinism snapshots are recorded as `temporal-bun-sdk/determinism` markers in workflow history and optionally cached via a sticky determinism cache. Tune cache behaviour with `TEMPORAL_STICKY_CACHE_SIZE` and `TEMPORAL_STICKY_TTL_MS`; the sticky worker queue inherits its schedule-to-start timeout from the TTL value.

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
   TEMPORAL_INTEGRATION_TESTS=1 pnpm --filter @proompteng/temporal-bun-sdk exec bun test tests/integration/worker-load.test.ts
   ```
2. **Developer-friendly CLI runner** (wraps the same scenario without `bun test`):
   ```bash
   pnpm --filter @proompteng/temporal-bun-sdk run test:load
   ```

Both commands start the Temporal CLI dev server (unless `TEMPORAL_TEST_SERVER=1` is set), run the worker load scenario, and write artefacts to `.artifacts/worker-load/`:

- `metrics.jsonl` – raw JSONL stream from the file metrics exporter.
- `report.json` – human-readable summary (config, peak concurrency, throughput, latency percentiles, sticky cache hit ratio).
- `temporal-cli.log` – CLI stdout/stderr captured during the run.

The default profile now submits 36 workflows (roughly a 2:1 mix of CPU-heavy to IO-heavy types) with worker poller concurrency of 10/14 (workflow/activity) and a 100-second workflow deadline. That keeps the CI run comfortably under two minutes while actually saturating the scheduler. The Bun test wrapper adds a 15-second safety buffer on top of `TEMPORAL_LOAD_TEST_TIMEOUT_MS + TEMPORAL_LOAD_TEST_METRICS_FLUSH_MS`, so keep that env var in sync with any threshold tweaks.

### Tuning the load harness

The harness is driven by env vars (also exposed as CLI flags via `--workflows`, `--workflow-concurrency`, `--activity-concurrency`, and `--timeout` when calling `pnpm run test:load`). Key overrides:

- `TEMPORAL_LOAD_TEST_WORKFLOWS` – total workflows to submit.
- `TEMPORAL_LOAD_TEST_WORKFLOW_CONCURRENCY` / `TEMPORAL_LOAD_TEST_ACTIVITY_CONCURRENCY` – poller counts / concurrency targets.
- `TEMPORAL_LOAD_TEST_WORKFLOW_POLL_P95_MS` / `TEMPORAL_LOAD_TEST_ACTIVITY_POLL_P95_MS` – max allowed P95 poll latency.
- `TEMPORAL_LOAD_TEST_STICKY_MIN_RATIO` – minimum sticky cache hit ratio before the suite fails.
- `TEMPORAL_LOAD_TEST_TIMEOUT_MS` – overall completion timeout per batch.
- `TEMPORAL_LOAD_TEST_ACTIVITY_BURSTS`, `TEMPORAL_LOAD_TEST_COMPUTE_ITERATIONS`, `TEMPORAL_LOAD_TEST_ACTIVITY_DELAY_MS`, `TEMPORAL_LOAD_TEST_ACTIVITY_PAYLOAD_BYTES` – fine-tune CPU/IO stress.

CI runs `pnpm --filter @proompteng/temporal-bun-sdk run test:load` inside `.github/workflows/temporal-bun-sdk.yml` and uploads `.artifacts/worker-load/{metrics.jsonl,report.json,temporal-cli.log}` so reviewers can inspect regressions. When running locally on slower hardware, lower the concurrency knobs or bump the latency thresholds to avoid spurious failures.

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
temporal-bun help                    Show available commands
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

## License
MIT © Proompt Engineering

## Worker versioning and build IDs

Workers derive their build ID from `TEMPORAL_WORKER_BUILD_ID`, the package version, or the configured identity. When `deployment.versioningMode` is `WorkerVersioningMode.VERSIONED`, `WorkerRuntime.create()` now:

1. Calls `GetWorkerBuildIdCompatibility` to confirm the WorkflowService supports worker versioning for the namespace/task queue.
2. Registers the build ID via `UpdateWorkerBuildIdCompatibility` before any pollers start, retrying transient `Unavailable`, `DeadlineExceeded`, `Aborted`, and `Internal` errors with incremental backoff.
3. Emits an info log so deploy pipelines can trace which build IDs were registered.

If the capability probe returns `Unimplemented` or `FailedPrecondition`, the runtime logs a warning and skips registration so local development servers (for example, the Temporal CLI dev server started via `bun scripts/start-temporal-cli.ts`) continue working even though they lack worker versioning APIs. Any other error aborts startup because versioned task queues will refuse to hand out work without a registered build ID.

Example logs:

```
[temporal-bun-sdk] registered worker build ID prix-worker@1.2.3 for default/prix
[temporal-bun-sdk] skipping worker build ID registration for default/prix: worker versioning API unavailable (Unimplemented (12)). If you are running against the Temporal CLI dev server via bun scripts/start-temporal-cli.ts this warning is expected because that server does not implement worker versioning APIs yet.
```

Production clusters should enable worker versioning, watch for the registration log during deploys, and alert on failures so versioned queues stay healthy.
