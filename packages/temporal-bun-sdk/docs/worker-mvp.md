# Worker MVP

The Worker MVP demonstrates the Bun worker runtime API and the surrounding ergonomics for
activities. The implementation is intentionally minimal and uses an in-memory bridge for local
execution while the Zig bridge is still under active development.

## API overview

```ts
import { Worker } from '@proompteng/temporal-bun-sdk/worker'
import { withHeartbeat } from '@proompteng/temporal-bun-sdk/worker'

const worker = new Worker(nativeClient, { taskQueue: 'worker-mvp-tq', concurrency: 2 })
worker.registerActivity('slowGreet', withHeartbeat(async (context, input) => {
  await context.heartbeat({ status: 'started' })
  await context.throwIfCancelled()
  return `Hello, ${input.name}!`
}))

await worker.run()
```

### Activity context helpers

* `context.heartbeat(details?)` — send a heartbeat payload.
* `context.isCancelled()` / `context.throwIfCancelled()` — probe cancellation and throw a
  structured `ActivityCancelledError`.
* `context.scheduleHeartbeat(everyMs, detailsProvider)` — utility used by
  `withHeartbeat` to emit periodic heartbeats.

The `withHeartbeat` helper wraps an activity handler and automatically schedules heartbeats for the
duration of the handler.

## Environment

The examples assume the default Temporal development stack:

* Server endpoint: `localhost:7233`
* Namespace: `default`
* Task queue: `worker-mvp-tq`

Override these values with environment variables when launching a worker:

* `TEMPORAL_ADDRESS`
* `TEMPORAL_NAMESPACE`
* `TEMPORAL_TASK_QUEUE`
* `TEMPORAL_WORKER_CONCURRENCY`

## Running the example

```bash
cd packages/temporal-bun-sdk
bun install
bun run examples/worker-mvp/run.ts
```

The example uses an in-memory bridge so that the worker runtime can be exercised without a running
Temporal server. The script starts a worker, enqueues three `slowGreet` activities, and waits for
completion.

## Tests

```bash
bun test tests/worker-mvp.e2e.test.ts
```

The test suite drives the worker through the in-memory bridge and verifies:

* bounded concurrency (configured to 2 while scheduling 5 tasks)
* heartbeats emitted at least twice for a long-running task
* cancellation for a single in-flight task
* graceful shutdown after a drain period

## Troubleshooting

* **Native bridge not available** — the Zig bridge currently exposes stub implementations for the
  worker functions. Supply a custom bridge (see the tests and examples) to exercise worker logic
  until the native layer is complete.
* **No activity handler registered** — ensure the activity name passed to `registerActivity` matches
  the `type` field in polled tasks.
* **Cancellation not observed** — invoke `context.throwIfCancelled()` within your activity or rely on
  `withHeartbeat`, which probes cancellation whenever it sends a heartbeat.
