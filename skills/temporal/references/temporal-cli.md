# Temporal quick reference

```bash
export TEMPORAL_ADDRESS=temporal-grpc.ide-newton.ts.net:7233
export TEMPORAL_NAMESPACE=default
```

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow list --limit 20

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow list \
  --query 'WorkflowType="reconcileAtlasRepository" and ExecutionStatus="Running"'

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow describe \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID"

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow show \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID" --output json > /tmp/workflow-history.json

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow result \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID"

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" task-queue describe \
  --task-queue bumba
```

Start Atlas only through the full-main command:

```bash
bun run atlas:rebuild --repository proompteng/lab --ref main
```

Routing verification uses the SDK-backed repository command because the pinned CLI does not expose current Worker
Deployment poller state:

```bash
bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue bumba --deployment-name bumba-deployment --dry-run
```
