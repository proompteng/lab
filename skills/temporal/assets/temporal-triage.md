# Temporal triage template

## Identity

- Namespace:
- Task queue:
- Worker Deployment:
- Workflow type:
- Workflow ID:
- Run ID:
- Current build ID:
- Running image digest:

## Exact failure

- Workflow status and history length:
- Pending activity state, attempt, heartbeat timeout, and last heartbeat time:
- Pod restart count and last termination reason:
- Routing current build and propagation state:
- Repository `indexStatus`, target/indexed commit, build ID, and prepared-file progress:

## Decision

- Is the worker attempt alive?
- Is routing `COMPLETED` for the running build?
- Is another repository build lease active?
- Is cancellation sufficient, or is exact-run termination required?

## Evidence commands

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow describe \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID"

kubectl -n jangar get pods -l app.kubernetes.io/name=bumba
kubectl -n jangar logs deploy/bumba --tail=300

bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue bumba --deployment-name bumba-deployment --dry-run
```

For Atlas, recover by fixing the concrete failure and running one `atlas:rebuild`. Do not revive deleted per-file
workflows or start a parallel corpus.
