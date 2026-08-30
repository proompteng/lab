# Temporal Triage Template

## Identity

- CLI version:
- Temporal service health:
- Namespace:
- Task queue:
- Worker Deployment:
- Workflow type:
- Workflow ID:
- Run ID:
- Current Build ID:
- Ramping Build ID and percentage:
- Running image digest:

## Exact Failure

- Workflow status and history length:
- Pending activity state, attempt, heartbeat timeout, and last heartbeat time:
- Pod restart count and last termination reason:
- Current and Ramping Version routing state:
- Version drainage state, task queues, and backlog:
- Repository routing propagation state:
- Repository `indexStatus`, target/indexed commit, Build ID, and prepared-file progress:

## Decision

- Is the Temporal service `SERVING`?
- Is the worker attempt alive?
- Does the Current or Ramping Version have the expected task queues and pollers?
- Is `routingConfigUpdateState=COMPLETED` for the running build?
- Is another repository build lease active?
- Is cancellation sufficient, or is exact-run termination required?
- If removing a version, is it drained, unreferenced by pinned workflows, and neither Current nor Ramping?

## Evidence Commands

```bash
temporal --version

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" operator cluster health

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow describe \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID"

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment describe \
  --name "$TEMPORAL_WORKER_DEPLOYMENT" --output json

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment describe-version \
  --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" \
  --build-id "$TARGET_BUILD_ID" \
  --report-task-queue-stats \
  --output json

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" task-queue describe \
  --task-queue "$TEMPORAL_TASK_QUEUE" \
  --select-build-id "$TARGET_BUILD_ID"

kubectl -n jangar get pods -l app.kubernetes.io/name=bumba
kubectl -n jangar logs deploy/bumba --tail=300

bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue "$TEMPORAL_TASK_QUEUE" --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" --dry-run
```

For Atlas, recover by fixing the concrete failure and running one `atlas:rebuild`. Do not revive deleted per-file
workflows or start a parallel corpus.
