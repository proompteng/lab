# Temporal CLI Reference

This reference was validated with Temporal CLI `1.8.2` on 2026-08-23. Run `temporal --version` and the relevant
`--help` before operating a different version. Temporal's Worker Versioning guide currently requires at least CLI
`1.4.1` and self-hosted Server `1.29.1`; those are feature minimums, not recommended pins.

## Connection And Health

```bash
export TEMPORAL_ADDRESS=temporal-grpc.ide-newton.ts.net:7233
export TEMPORAL_NAMESPACE=default

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" operator cluster health
```

## Workflow Inspection

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
```

Start Atlas only through the full-main command:

```bash
bun run atlas:rebuild --repository proompteng/lab --ref main
```

## Worker Deployment Inspection

```bash
export TEMPORAL_TASK_QUEUE=bumba
export TEMPORAL_WORKER_DEPLOYMENT=bumba-deployment

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment list

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment describe \
  --name "$TEMPORAL_WORKER_DEPLOYMENT" --output json | jq '{name, routingConfig, versionSummaries}'

CURRENT_BUILD_ID="$(
  temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment describe \
    --name "$TEMPORAL_WORKER_DEPLOYMENT" --output json |
    jq -er '.routingConfig.currentVersionBuildID | select(length > 0)'
)"

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment describe-version \
  --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" \
  --build-id "$CURRENT_BUILD_ID" \
  --report-task-queue-stats \
  --output json | jq '{deploymentName, BuildID, currentSinceTime, rampingSinceTime, rampPercentage, drainageInfo, taskQueuesInfos}'

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" task-queue describe \
  --task-queue "$TEMPORAL_TASK_QUEUE" \
  --select-build-id "$CURRENT_BUILD_ID"
```

Interpret `routingConfig.currentVersionBuildID` and `routingConfig.rampingVersionBuildID` separately. A zero ramping
percentage with an empty ramping Build ID means no ramp is configured. For removal, require `drainageStatus=drained` and
independent proof of no pollers or pinned workflows. `describe-version --report-task-queue-stats` reports drainage and
queues; use `task-queue describe --select-build-id` for a recent-poller readback. An empty poller table is not sufficient
deletion evidence by itself; cross-check live Worker pods and logs, recent workflow-task execution, and drainage state.

## Bumba/Jangar Propagation Cross-Check

```bash
bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --address "$TEMPORAL_ADDRESS" \
  --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue "$TEMPORAL_TASK_QUEUE" \
  --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" \
  --dry-run
```

This repository command proves Bumba/Jangar's `routingConfigUpdateState=COMPLETED` readiness contract. It complements,
rather than replaces, direct CLI inspection.

## Authorized Routing Changes

These commands mutate live routing. Do not run them merely because they are listed here. First inspect the deployment,
target version, task queues, active pollers, workflow compatibility, and rollback build; then require authorization for
the exact routing result.

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment set-ramping-version \
  --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" \
  --build-id "$TARGET_BUILD_ID" \
  --percentage "$RAMP_PERCENTAGE"

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment set-current-version \
  --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" \
  --build-id "$TARGET_BUILD_ID"
```

Do not add `--allow-no-pollers` or `--ignore-missing-task-queues` to bypass safety checks. Setting a ramp to 100 percent
does not make that version Current; use the Current-Version operation only after the ramp has passed its acceptance gate.

## Authorized Version Deletion

Unused Worker Deployment Versions are normally garbage-collected. Manual deletion is exceptional. Immediately before
deletion, prove the target is neither Current nor Ramping, is `drained`, has no active pollers, and has no pinned workflow.
One empty CLI poller table does not satisfy that proof.

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment describe-version \
  --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" \
  --build-id "$TARGET_BUILD_ID" \
  --report-task-queue-stats \
  --output json

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" task-queue describe \
  --task-queue "$TARGET_TASK_QUEUE" \
  --select-build-id "$TARGET_BUILD_ID"

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" worker deployment delete-version \
  --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" \
  --build-id "$TARGET_BUILD_ID"
```

Never use `--skip-drainage` as routine cleanup or incident recovery.

## Official Sources

- Worker Versioning concepts, lifecycle, and minimum versions:
  <https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning>
- Generated CLI worker command reference: <https://docs.temporal.io/cli/worker>
- Temporal CLI release history: <https://github.com/temporalio/cli/releases>
