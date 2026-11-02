# RPC coverage

The Bun SDK exposes WorkflowService, OperatorService, and CloudService RPCs via
stable client namespaces. All RPCs accept `TemporalClientCallOptions` (timeout,
retry overrides, headers, abort signals).

## WorkflowService

### High-level convenience

- `client.workflow.*` (start, signal, query, update, cancel, terminate, result)
- `client.schedules.*` (create/describe/update/patch/list/delete/trigger/backfill/pause/unpause/listMatchingTimes)
- `client.workflowOps.*` (updateExecutionOptions/pause/unpause/resetStickyTaskQueue)
- `client.workerOps.*` (list/describe/fetchConfig/updateConfig/updateTaskQueueConfig/versioning)
- `client.deployments.*` (list/describe/get/set current, reachability, version metadata)

### Full RPC surface

For any additional WorkflowService RPCs, use the low-level RPC helper:

```ts
await client.rpc.workflow.call('listOpenWorkflowExecutions', {
  namespace: 'default',
  maximumPageSize: 100,
})
```

`client.rpc.workflow.call()` is a typed wrapper over the generated
WorkflowService client, and it honors `TemporalClientCallOptions`.

## OperatorService

### High-level convenience

- `client.operator.*` for search attribute and Nexus endpoint operations

### Full RPC surface

Use `client.rpc.operator.call()` for any OperatorService RPCs:

```ts
await client.rpc.operator.call('listSearchAttributes', { namespace: 'default' })
```

## CloudService

Temporal Cloud Ops API is exposed via `client.cloud.call()` (and mirrored under
`client.rpc.cloud`). It supports all CloudService RPCs from
`temporal/api/cloud/cloudservice/v1/service.proto`:

```ts
await client.cloud.call('getNamespaces', {})
```

### Cloud configuration

Enable Cloud Ops by setting:

- `TEMPORAL_CLOUD_ADDRESS` (defaults to `saas-api.tmprl.cloud:443` when Cloud is enabled)
- `TEMPORAL_CLOUD_API_KEY` (Bearer token)
- `TEMPORAL_CLOUD_API_VERSION` (default `2025-05-31`)

The SDK injects the required `authorization` and `temporal-cloud-api-version`
headers automatically; per-call overrides are supported via
`TemporalClientCallOptions`.
