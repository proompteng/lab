# Testing environment

The Temporal Bun SDK ships a Bun-friendly `TestWorkflowEnvironment` wrapper so
workflow tests can boot a worker and connect to a dev server without hand-rolled
plumbing.

## Capabilities

- **Local dev server** via the bundled Temporal CLI scripts.
- **Time-skipping server** support when the CLI (or your own server) is started
  with `--time-skipping`.
- **Existing server** support for integration environments.

## API surface

```ts
import { TestWorkflowEnvironment } from '@proompteng/temporal-bun-sdk'

const env = await TestWorkflowEnvironment.createLocal({
  address: '127.0.0.1:7233',
  namespace: 'default',
  taskQueue: 'unit-tests',
})

const { worker } = await env.createWorker({
  workflows,
  activities,
  taskQueue: 'unit-tests',
})

const workerPromise = worker.run()
// ... run workflow tests ...
await worker.shutdown()
await workerPromise
await env.shutdown()
```

### Constructors

- `TestWorkflowEnvironment.createLocal(options)`
  - Starts the Temporal CLI dev server (unless `reuseExistingServer` is true).
  - Uses `packages/temporal-bun-sdk/scripts/start-temporal-cli.ts` and
    `stop-temporal-cli.ts`.
- `TestWorkflowEnvironment.createTimeSkipping(options)`
  - Starts the Temporal CLI dev server with `--time-skipping` when
    `reuseExistingServer` is false.
  - Use this when you need deterministic time-skipping in workflow tests.
- `TestWorkflowEnvironment.createExisting(options)`
  - Connects to an already-running server without touching the CLI.

### Worker integration

`TestWorkflowEnvironment.createWorker()` delegates to `createWorker` with the
resolved config, so `createWorker` integration runs end-to-end using the same
workflow/activity registration path as production.

## Configuration and environment

The helper honors these environment variables:

- `TEMPORAL_CLI_PATH` overrides the Temporal CLI binary used by the scripts.
- `TEMPORAL_PORT` (derived from `address`) controls the dev server port.
- `TEMPORAL_TIME_SKIPPING=1` enables the CLI `--time-skipping` flag.

When `reuseExistingServer` is true, no CLI process is spawned and shutdown only
closes the client.

## Error handling

`TemporalTestServerUnavailableError` is thrown when the CLI script is missing or
fails to start the dev server.
