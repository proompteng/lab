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
   TEMPORAL_WORKFLOW_CONCURRENCY=4                  # optional – workflow pollers
   TEMPORAL_ACTIVITY_CONCURRENCY=4                  # optional – activity pollers
   TEMPORAL_STICKY_CACHE_SIZE=256                   # optional – determinism cache capacity
   TEMPORAL_STICKY_TTL_MS=300000                    # optional – eviction TTL in ms
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

## Worker versioning and build IDs

Workers derive their build ID from , , or the configured identity. When the runtime runs in , it registers the build ID with Temporal via  before starting any pollers. Fatal RPC failures (, ) abort startup, transient errors (, , , ) are retried, and success is logged via  so you can trace the registration.

The Temporal CLI dev server packaged into  does **not** support . The helper treats / as “feature unavailable”, logs a warning, and keeps the worker running. Because the script shells out to the The Temporal CLI manages, monitors, and debugs Temporal apps. It lets you run
a local Temporal Service, start Workflow Executions, pass messages to running
Workflows, inspect state, and more.

* Start a local development service:
      `temporal server start-dev`
* View help: pass `--help` to any command:
      `temporal activity complete --help`

Usage:
  temporal [command]

Available Commands:
  activity    Complete, update, pause, unpause, reset or fail an Activity
  batch       Manage running batch jobs
  completion  Generate the autocompletion script for the specified shell
  config      Manage config files (EXPERIMENTAL)
  env         Manage environments
  help        Help about any command
  operator    Manage Temporal deployments
  schedule    Perform operations on Schedules
  server      Run Temporal Server
  task-queue  Manage Task Queues
  worker      Read or update Worker state
  workflow    Start, list, and operate on Workflows

Flags:
      --client-connect-timeout duration                   The client connection timeout. 0s means no timeout. (default 0s)
      --color string                                      Output coloring. Accepted values: always, never, auto. (default "auto")
      --command-timeout duration                          The command execution timeout. 0s means no timeout. (default 0s)
      --config-file $CONFIG_PATH/temporal/temporal.toml   File path to read TOML config from, defaults to $CONFIG_PATH/temporal/temporal.toml where `$CONFIG_PATH` is defined as `$HOME/.config` on Unix, "$HOME/Library/Application Support" on macOS, and %AppData% on Windows. EXPERIMENTAL.
      --disable-config-env                                If set, disables loading environment config from environment variables. EXPERIMENTAL.
      --disable-config-file                               If set, disables loading environment config from config file. EXPERIMENTAL.
      --env ENV                                           Active environment name (ENV). (default "default")
      --env-file $HOME/.config/temporalio/temporal.yaml   Path to environment settings file. Defaults to $HOME/.config/temporalio/temporal.yaml.
  -h, --help                                              help for temporal
      --log-format string                                 Log format. Accepted values: text, json. (default "text")
      --log-level server start-dev                        Log level. Default is "info" for most commands and "warn" for server start-dev. Accepted values: debug, info, warn, error, never. (default "info")
      --no-json-shorthand-payloads                        Raw payload output, even if the JSON option was used.
  -o, --output string                                     Non-logging data output format. Accepted values: text, json, jsonl, none. (default "text")
      --profile string                                    Profile to use for config file. EXPERIMENTAL.
      --time-format string                                Time format. Accepted values: relative, iso, raw. (default "relative")
  -v, --version                                           version for temporal

Use "temporal [command] --help" for more information about a command. binary, ensure The Temporal CLI manages, monitors, and debugs Temporal apps. It lets you run
a local Temporal Service, start Workflow Executions, pass messages to running
Workflows, inspect state, and more.

* Start a local development service:
      `temporal server start-dev`
* View help: pass `--help` to any command:
      `temporal activity complete --help`

Usage:
  temporal [command]

Available Commands:
  activity    Complete, update, pause, unpause, reset or fail an Activity
  batch       Manage running batch jobs
  completion  Generate the autocompletion script for the specified shell
  config      Manage config files (EXPERIMENTAL)
  env         Manage environments
  help        Help about any command
  operator    Manage Temporal deployments
  schedule    Perform operations on Schedules
  server      Run Temporal Server
  task-queue  Manage Task Queues
  worker      Read or update Worker state
  workflow    Start, list, and operate on Workflows

Flags:
      --client-connect-timeout duration                   The client connection timeout. 0s means no timeout. (default 0s)
      --color string                                      Output coloring. Accepted values: always, never, auto. (default "auto")
      --command-timeout duration                          The command execution timeout. 0s means no timeout. (default 0s)
      --config-file $CONFIG_PATH/temporal/temporal.toml   File path to read TOML config from, defaults to $CONFIG_PATH/temporal/temporal.toml where `$CONFIG_PATH` is defined as `$HOME/.config` on Unix, "$HOME/Library/Application Support" on macOS, and %AppData% on Windows. EXPERIMENTAL.
      --disable-config-env                                If set, disables loading environment config from environment variables. EXPERIMENTAL.
      --disable-config-file                               If set, disables loading environment config from config file. EXPERIMENTAL.
      --env ENV                                           Active environment name (ENV). (default "default")
      --env-file $HOME/.config/temporalio/temporal.yaml   Path to environment settings file. Defaults to $HOME/.config/temporalio/temporal.yaml.
  -h, --help                                              help for temporal
      --log-format string                                 Log format. Accepted values: text, json. (default "text")
      --log-level server start-dev                        Log level. Default is "info" for most commands and "warn" for server start-dev. Accepted values: debug, info, warn, error, never. (default "info")
      --no-json-shorthand-payloads                        Raw payload output, even if the JSON option was used.
  -o, --output string                                     Non-logging data output format. Accepted values: text, json, jsonl, none. (default "text")
      --profile string                                    Profile to use for config file. EXPERIMENTAL.
      --time-format string                                Time format. Accepted values: relative, iso, raw. (default "relative")
  -v, --version                                           version for temporal

Use "temporal [command] --help" for more information about a command. is on your  before running  so you can surface that warning in local validation runs.
