# Worker ops, versioning, and deployments

The Bun SDK exposes worker operations, versioning, and deployment management via
stable client namespaces. These map directly to WorkflowService RPCs with full
call-option support.

## Worker operations

`client.workerOps` provides:

- `list` / `describe` workers
- `fetchConfig` / `updateConfig`
- `updateTaskQueueConfig`
- `getVersioningRules` / `updateVersioningRules`

## Workflow execution operations

`client.workflowOps` provides:

- `updateExecutionOptions`
- `pauseExecution` / `unpauseExecution`
- `resetStickyTaskQueue`

## Deployments

`client.deployments` provides:

- `listWorkerDeployments` / `describeWorkerDeployment`
- `listDeployments` / `describeDeployment`
- `getCurrentDeployment` / `setCurrentDeployment`
- `getDeploymentReachability`
- `setWorkerDeploymentCurrentVersion`
- `setWorkerDeploymentRampingVersion`
- `updateWorkerDeploymentVersionMetadata`
- `deleteWorkerDeploymentVersion` / `deleteWorkerDeployment`
- `setWorkerDeploymentManager`

## Worker runtime versioning

Worker versioning is controlled via `WorkerRuntimeOptions.deployment`:

```ts
await WorkerRuntime.create({
  deployment: {
    name: 'payments-deployment',
    buildId: 'payments@1.2.3',
    versioningMode: WorkerVersioningMode.VERSIONED,
    versioningBehavior: VersioningBehavior.UNSPECIFIED,
  },
})
```

The runtime will register build IDs when versioning is enabled, and safely
fallback if the server does not support versioning (e.g., local CLI dev server).
