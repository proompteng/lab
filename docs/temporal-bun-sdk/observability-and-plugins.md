# Observability, plugins, and tuners

The Bun SDK includes a full observability stack and an extensible worker plugin
system with dynamic concurrency tuning.

## Observability

- **Logging**: structured logger with `json`/`pretty` formats.
- **Metrics**: in-memory, Prometheus, file, and OTLP exporters.
- **Tracing**: OpenTelemetry SDK integration with OTLP exporter support.

Enable exporters with existing environment variables (see main SDK docs). Metrics
and tracing work for client and worker operations end-to-end.

## Worker plugins

Worker plugins allow you to attach hooks for lifecycle and scheduling events:

```ts
import type { WorkerPlugin } from '@proompteng/temporal-bun-sdk'

const plugin: WorkerPlugin = {
  name: 'custom-metrics',
  onWorkerStart: ({ logger }) => Effect.sync(() => logger.info('worker started')),
  schedulerHooks: {
    onWorkflowStart: (task) => Effect.sync(() => console.log('workflow task', task.workflowId)),
  },
}

await WorkerRuntime.create({
  plugins: [plugin],
})
```

## Dynamic concurrency tuning

Provide a `WorkerTuner` to update workflow/activity concurrency while the
worker is running:

```ts
import { createStaticWorkerTuner } from '@proompteng/temporal-bun-sdk'

await WorkerRuntime.create({
  tuner: createStaticWorkerTuner({ workflow: 8, activity: 4 }),
})
```

Custom tuners can implement `subscribe(listener)` to push live updates. The
runtime rebuilds the scheduler when updates arrive and logs each change.

### Opt-in behavior

Both plugins and tuners are opt-in through `WorkerRuntimeOptions` and do not
alter existing worker behavior unless explicitly configured.
