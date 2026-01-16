# Temporal Bun SDK - Worker Ops and Versioning

## Goal
Expose a first-class client surface for worker operations, versioning, and
deployments supported by Temporal server and sdk-core.

## Non-Goals
- Implementing Temporal server-side versioning policies.
- Migrating existing workers automatically.

## Requirements
1. Before implementation, check out `https://github.com/temporalio/sdk-core` and
   `https://github.com/temporalio/sdk-typescript` to confirm upstream behavior.
2. Worker ops RPCs:
   - List/Describe workers.
   - Record worker heartbeat.
   - Fetch/Update worker config.
   - Update task queue config.
3. Worker versioning rules:
   - Get/Update worker versioning rules per task queue.
   - Register build IDs with compatibility sets.
4. Deployment APIs:
   - Describe/List deployments.
   - Get/Set current deployment.
   - Reachability checks.
   - Worker deployment CRUD and version metadata.
5. Workflow admin:
   - Update workflow execution options.
   - Pause/Unpause workflow execution.
6. Sticky queue management:
   - Reset sticky task queue RPC.

## API Sketch
```ts
const client = await createTemporalClient({ config })

await client.workerOps.recordHeartbeat({ identity: 'worker-1' })
const workers = await client.workerOps.listWorkers({ query: 'taskQueue = "bumba"' })

await client.versioning.updateRules({ taskQueue: 'bumba', rules })
await client.deployments.setCurrent({ deploymentName: 'v2', identity: 'operator' })

await client.workflowAdmin.pause({ workflowId, reason: 'maintenance' })
await client.workflowAdmin.updateOptions({ workflowId, runId, options, updateMask })
```

## Implementation Notes
- Use workflowservice RPCs already available in generated protos:
  `ListWorkers`, `DescribeWorker`, `RecordWorkerHeartbeat`,
  `FetchWorkerConfig`, `UpdateWorkerConfig`, `UpdateTaskQueueConfig`,
  `UpdateWorkflowExecutionOptions`, `PauseWorkflowExecution`,
  `UnpauseWorkflowExecution`, `ResetStickyTaskQueue`.
- Add `workerOps`, `versioning`, `deployments`, and `workflowAdmin` namespaces
  to `TemporalClient` to keep core workflow APIs clean.

## Acceptance Criteria
- All RPCs pass through configured retry policy + auth headers.
- Clear error surfaces for `Unimplemented` and `FailedPrecondition`.
- Tests cover at least list/describe + update workflow options + reset sticky.
