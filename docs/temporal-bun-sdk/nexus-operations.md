# Temporal Bun SDK - Nexus Operations

## Goal
Implement Nexus operations end-to-end in the Bun SDK (poll, execute, cancel,
respond), with ergonomics that exceed the TypeScript SDK.

## Non-Goals
- Building a Nexus gateway or endpoint registry UI.
- Supporting Nexus on servers that do not enable the feature.

## Requirements
1. Before implementation, check out `https://github.com/temporalio/sdk-core` and
   `https://github.com/temporalio/sdk-typescript` to confirm upstream behavior.
2. Worker polls `PollNexusTaskQueue` when Nexus services are registered.
3. Handler runtime with cancellation and structured errors.
4. Client helper to call Nexus operations from workflows and services.
5. Propagate links, request IDs, and headers in a deterministic way.
6. Observability hooks: metrics, logs, and tracing per operation.

## API Sketch
```ts
import { createNexusClient } from '@proompteng/temporal-bun-sdk/nexus'

const nexus = createNexusClient({ endpoint: 'endpoint-1' })
const result = await nexus.execute('summarize', { text: 'hello' })
```

Worker registration:
```ts
await createWorker({
  workflowsPath,
  activities,
  nexus: {
    services: {
      summarize: async ({ input }) => ({ output: input.text })
    },
  },
})
```

## Error Semantics
- Map Nexus handler errors to Temporal failure fields with retry behavior.
- Support explicit `retryBehavior` mapping to server enums.

## Implementation Notes
- Use the workflowservice RPCs:
  - `PollNexusTaskQueue`
  - `RespondNexusTaskCompleted`
  - `RespondNexusTaskFailed`
- Add effectful interceptor hooks for inbound/outbound Nexus calls.

## Acceptance Criteria
- Nexus handler cancellation works and reports the proper failure info.
- Operations can be called from workflow code without breaking determinism.
- Metrics include latency and failure causes.
