# Nexus operations

The Bun SDK supports Nexus operations inside workflows and surfaces the
associated control-plane APIs via the Operator and Cloud clients.

## Workflow Nexus API

Workflows can schedule and cancel Nexus operations through the workflow context:

```ts
const result =
  yield *
  ctx.nexus.schedule(
    'endpoint',
    'service',
    'operation',
    { payload: 'value' },
    {
      scheduleToCloseTimeoutMs: 60_000,
      operationId: 'op-123',
    },
  )

// Cancel by operation id (or by scheduled event id when available)
yield * ctx.nexus.cancel('op-123')
```

### Behavior

- The SDK injects an operation id header (`x-temporal-bun-operation-id`) for
  deterministic mapping between schedule/cancel events.
- Results and failures are resolved deterministically during replay.
- Failed, canceled, and timed-out operations are converted into structured
  `Error` instances with decoded failure payloads.

## Observability hooks

Nexus operations integrate with the worker runtime’s scheduling and plugin
hooks:

- Scheduler hooks fire on workflow task start/complete, so Nexus commands are
  captured alongside workflow tasks.
- Worker plugins can emit additional telemetry around Nexus usage by observing
  workflow task envelopes.

## Operator + Cloud Nexus APIs

Nexus endpoints are managed via:

- `client.operator.createNexusEndpoint`, `updateNexusEndpoint`, `deleteNexusEndpoint`,
  `getNexusEndpoint`, `listNexusEndpoints` (OperatorService)
- `client.cloud.call('getNexusEndpoints', ...)` and related CloudService RPCs
  when Temporal Cloud Ops API is configured.
