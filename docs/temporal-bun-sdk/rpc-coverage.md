# Temporal Bun SDK - RPC Coverage Requirements

## Goal
Document all WorkflowService/Operator/Cloud RPCs that the Bun SDK should expose
beyond the current client surface. This is a requirements checklist, not an
implementation plan.

## Scope
- WorkflowService RPCs already present in proto stubs but not surfaced in the
  Bun SDK client.
- OperatorService RPCs needed for admin workflows.
- CloudService RPCs needed for Temporal Cloud operations.

## Requirements - WorkflowService

### Worker and Task Queue Operations
1. `ListWorkers` - list active workers in a namespace with optional query.
2. `DescribeWorker` - detailed worker info for diagnostics.
3. `RecordWorkerHeartbeat` - explicit worker heartbeat submission.
4. `FetchWorkerConfig` - fetch server-side worker config defaults.
5. `UpdateWorkerConfig` - update server-side worker config.
6. `UpdateTaskQueueConfig` - update task queue rate limits and fairness settings.
7. `DescribeTaskQueue` and `ListTaskQueuePartitions` - enhanced diagnostics.

### Worker Versioning and Deployments
1. `GetWorkerBuildIdCompatibility` - capability probe and build ID info.
2. `UpdateWorkerBuildIdCompatibility` - build ID registration.
3. `GetWorkerVersioningRules` - read worker versioning rules per task queue.
4. `UpdateWorkerVersioningRules` - update worker versioning rules.
5. `DescribeDeployment` / `ListDeployments`.
6. `GetCurrentDeployment` / `SetCurrentDeployment`.
7. `GetDeploymentReachability`.
8. Worker deployment CRUD + versions:
   - `DescribeWorkerDeployment`
   - `ListWorkerDeployments`
   - `DeleteWorkerDeployment`
   - `DescribeWorkerDeploymentVersion`
   - `ListWorkerDeploymentVersions`
   - `DeleteWorkerDeploymentVersion`
   - `SetWorkerDeploymentCurrentVersion`
   - `SetWorkerDeploymentRampingVersion`
   - `UpdateWorkerDeploymentVersionMetadata`
   - `SetWorkerDeploymentManager`

### Workflow Execution Admin
1. `UpdateWorkflowExecutionOptions` - update execution options with masks.
2. `PauseWorkflowExecution` / `UnpauseWorkflowExecution`.
3. `ResetStickyTaskQueue` - explicit sticky reset.

### Activity Admin
1. `UpdateActivityOptions`.
2. `PauseActivity` / `UnpauseActivity`.
3. `ResetActivity`.
4. `StartActivityExecution`.

### Schedules
1. `CreateSchedule`.
2. `DescribeSchedule`.
3. `UpdateSchedule`.
4. `PatchSchedule`.
5. `ListScheduleMatchingTimes`.
6. `DeleteSchedule`.
7. `ListSchedules`.

### Nexus Operations
1. `PollNexusTaskQueue`.
2. `RespondNexusTaskCompleted`.
3. `RespondNexusTaskFailed`.

## Requirements - OperatorService
1. Search attributes admin:
   - `AddSearchAttributes`
   - `RemoveSearchAttributes`
   - `ListSearchAttributes`
2. Namespace admin:
   - `RegisterNamespace`
   - `UpdateNamespace`
   - `DeprecateNamespace`
   - `DeleteNamespace`
   - `DescribeNamespace`
   - `ListNamespaces`
3. Nexus endpoint admin:
   - `GetNexusEndpoint`
   - `CreateNexusEndpoint`
   - `UpdateNexusEndpoint`
   - `DeleteNexusEndpoint`
   - `ListNexusEndpoints`

## Requirements - CloudService (Temporal Cloud)
1. Nexus endpoint admin (cloud variants):
   - `GetNexusEndpoints`
   - `GetNexusEndpoint`
   - `CreateNexusEndpoint`
   - `UpdateNexusEndpoint`
   - `DeleteNexusEndpoint`
2. Any other CloudService RPCs required for deployment workflows
   (to be added as product requirements evolve).

## Common Requirements
- All RPCs must accept standard call options (timeout, retry policy, headers,
  abort signal).
- RPCs must be exposed through stable client namespaces (e.g. `client.workerOps`,
  `client.schedules`, `client.admin`, `client.nexus`).
- Errors must preserve gRPC codes and messages, with `Unimplemented` and
  `FailedPrecondition` clearly surfaced.
- Each RPC must have test coverage (unit mocks + at least one integration test
  per functional area).
