# Temporal Bun SDK – Workflow Update Support

## Overview

Temporal Workflow Updates let callers send strongly typed, low-latency mutations to running workflows without relying on signals/queries. This document captures the design and operational considerations for the Bun SDK implementation.

## Components

### Client surface

- `TemporalWorkflowClient.workflow.update()` issues `UpdateWorkflowExecutionRequest` RPCs.
- Helper APIs (`getUpdateHandle`, `awaitUpdate`, `cancelUpdate`) let services resume or cancel pending updates.
- Update calls inherit the standard call options (`retryPolicy`, `timeoutMs`, `headers`, `signal`).
- `workflow.update` assigns an idempotent `updateId` (callers can override it) and defaults to waiting until the update is **accepted**; `waitForStage` can be set to `'admitted' | 'accepted' | 'completed'`.
- `workflow.awaitUpdate` defaults to waiting until the update is **completed** when no `waitForStage` is provided, matching Temporal's server-side default.
- The client records per-update AbortControllers so cancelling an update (or aborting a request) cleans up pending polls appropriately.

### Workflow runtime

- Workflows register update handlers via `defineWorkflowUpdates` and `workflowContext.updates.register`.
- `WorkflowExecutor` passes incoming invocations through Effect Schema validators, records update determinism entries for `admitted`, `accepted`, `rejected`, and `completed` stages, and surfaces dispatch metadata (acceptance/rejection/completion) to the worker runtime.

### Worker runtime

- `collectWorkflowUpdates` reads `PollWorkflowTaskQueueResponse.messages`, decoding `temporal.api.update.v1.Request` payloads into invocation structs.
- `WorkflowExecutor` runs registered handlers deterministically; `buildUpdateProtocolMessages` translates dispatches into protocol `Acceptance`, `Rejection`, and `Response` messages and attaches them to `RespondWorkflowTaskCompleted`.
- Scheduler fairness: update protocol messages piggyback on workflow tasks, so updates share the workflow concurrency lane. Most updates are short-lived RPCs, but long-running handler code should be treated like normal workflow code (no async side-effects, deterministic behavior).

### Determinism & replay

- `WorkflowDeterminismState` now tracks update lifecycle entries. Replay ingestion consumes `WORKFLOW_EXECUTION_UPDATE_*` history events; sticky cache snapshots include sequencing/event IDs so drift detection works out of the box.
- Determinism markers encode update state alongside command history; if markers are missing, replay reconstructs update entries from history.

## Operational guidance

### Configuration

- Ensure workers poll `messages` on workflow tasks. The SDK already passes `messages` through; if you implement your own poller, include protocol message handling.
- Temporal server version must include Workflow Update GA (Cloud and ≥1.22 server builds).
- When running against dev clusters (`temporal server start-dev`), enable updates via `temporal server start-dev --enable-workflow-updates` if required.

### Metrics & observability

- Worker logs include update dispatch outcomes at `debug` level; promote them to structured logs if you need audit trails.
- Determinism mismatches will now mention update entries (kind = 'update'), helping you debug cases where the worker admitted/rejected updates differently from history.

### Rollout plan

- Deploy the SDK update to a staging namespace first; verify `workflow.update` calls succeed and determinism markers continue to sync.
- Monitor worker logs for `workflow update message missing identifiers` or `failed to decode workflow update request`; those indicate mismatched protocol payloads.
- If you need to disable updates temporarily, skip calling `workflow.update` and leave registered handlers in place; they are no-ops when no update protocol messages arrive.

## Quick reference

### Registering updates

```ts
import { defineWorkflow, defineWorkflowUpdates } from '@proompteng/temporal-bun-sdk/workflow'
import * as Schema from 'effect/Schema'

const updates = defineWorkflowUpdates([
  {
    name: 'setCounter',
    input: Schema.Number,
    handler: async ({ info }, value: number) => {
      console.log('Update from', info.workflowId, 'value', value)
      return value
    },
  },
])

export const counterWorkflow = defineWorkflow(
  'counterWorkflow',
  Schema.Number,
  ({ input, updates }) => {
    let count = input

    updates.register(updates[0], async (_ctx, value) => {
      count = value
      return count
    })

    return Effect.sync(() => count)
  },
  { updates },
)
```

### Invoking updates

```ts
const result = await client.workflow.update(handle, {
  updateName: 'setCounter',
  args: [42],
  waitForStage: 'completed',
})

if (result.outcome?.status === 'success') {
  console.log('Counter updated to', result.outcome.result)
}
```

### Monitoring

- Use `temporal workflow update` CLI commands or Cloud UI to inspect update states.
- Worker logs emitted when decoding protocol messages: enable `LOG_LEVEL=debug` if you need to trace update routing.
- Determinism mismatches now show `kind: 'update'` entries referencing update IDs.
