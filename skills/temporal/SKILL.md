---
name: temporal
description: 'Operate and troubleshoot Temporal workflows, task queues, and Worker Deployments in this repository. Use for Temporal health, workflow history, Bumba routing, version drainage, cancellation, termination, and recovery.'
---

# Temporal Operations

## Establish Current CLI And Service State

Temporal CLI commands evolve. Before relying on remembered flags, inspect the installed version and the relevant command
group:

```bash
temporal --version
temporal worker deployment --help

export TEMPORAL_ADDRESS=temporal-grpc.ide-newton.ts.net:7233
export TEMPORAL_NAMESPACE=default

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" operator cluster health
```

Always pass the address and namespace explicitly. This skill was revalidated against Temporal CLI `1.8.2` on
2026-08-23. If the installed CLI differs, use its `--help` and the official command reference before adapting a command.

## Inspect Workflows

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow list --limit 20

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow describe \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID"

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow show \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID" --output json > /tmp/workflow-history.json
```

For Atlas, the only ingestion workflow type is `reconcileAtlasRepository`:

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow list \
  --query 'WorkflowType="reconcileAtlasRepository" and ExecutionStatus="Running"'
```

## Start Atlas Reconciliation

```bash
bun run atlas:rebuild --repository proompteng/lab --ref main
```

This starts one full current-main reconciliation and waits for its result. Per-file and partial-repository workflow
entrypoints no longer exist. Do not start a second rebuild while a live one can still write.

## Inspect Worker Deployment Routing

Use the CLI first for read-only routing, version, drainage, and task-queue evidence:

```bash
TEMPORAL_TASK_QUEUE=bumba
TEMPORAL_WORKER_DEPLOYMENT=bumba-deployment

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
  --output json

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" task-queue describe \
  --task-queue "$TEMPORAL_TASK_QUEUE" \
  --select-build-id "$CURRENT_BUILD_ID"
```

Then use the repository command as the Bumba/Jangar application-specific propagation check:

```bash
bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --address "$TEMPORAL_ADDRESS" \
  --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue "$TEMPORAL_TASK_QUEUE" \
  --deployment-name "$TEMPORAL_WORKER_DEPLOYMENT" \
  --dry-run
```

Bumba and Jangar start their poller, select their exact configured build, and wait for
`routingConfigUpdateState=COMPLETED` before readiness. The CLI proves Temporal's routing, version, drainage, and task-queue
state; the dry-run proves the repository-specific propagation contract for the selected build. Require both plus a ready
live worker and recent successful workflow-task execution when validating a rollout. An empty CLI poller table is not, by
itself, proof that no Worker is active.

## Mutation Boundary

Worker Deployment routing changes, version deletion, workflow cancellation, termination, reset, and versioning-override
changes mutate live Temporal state. Execute them only when the user has authorized that exact outcome and the target has
been read back immediately beforehand.

Before deleting a Worker Deployment Version, prove all of the following:

- it is neither the Current nor Ramping Version;
- its drainage state is `drained`, not `draining` or `unspecified`;
- it has no active pollers on any associated task queue;
- no pinned workflow still requires it;
- the exact deployment name and Build ID were independently verified.

Unused versions are normally garbage-collected. Do not use `--skip-drainage`, `--allow-no-pollers`, or
`--ignore-missing-task-queues` as incident shortcuts. Do not infer zero active pollers from one empty
`task-queue describe` result; pair it with current Kubernetes worker inventory, recent Worker logs, and version drainage.

## Cancel Or Terminate

Cancel cooperative work:

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow cancel \
  --workflow-id "$WORKFLOW_ID"
```

Terminate only when the exact run must stop and the reason is documented:

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow terminate \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID" --reason '<incident reason>'
```

## Failure Interpretation

- Cluster health not `SERVING`: diagnose Temporal service and persistence before worker routing.
- No workflow-task start: inspect the Current/Ramping Version, active pollers, and task-queue backlog.
- `ScheduleToStart` timeout: verify task-queue and Worker Deployment routing before retrying the workflow.
- Heartbeat timeout after worker exit: crash detection; the activity should retry with its last details.
- Running activity with heartbeat timeout `0` after a worker death: pre-hardening dead attempt; prove it is dead, terminate
  that exact run, deploy the current worker, and start one reconciliation.
- Nondeterminism: inspect history and `docs/temporal-nondeterminism.md`; reset only to a proven safe event.
- A drained version is a decommissioning signal, not proof that the current version has healthy pollers or application
  readiness.

## Resources

- Command reference and authorized mutation templates: `references/temporal-cli.md`
- Runner: `scripts/temporal-run.sh`
- Triage template: `assets/temporal-triage.md`
- Bumba incidents: `docs/runbooks/bumba-temporal-failure-modes.md`
- Official Worker Versioning guide:
  <https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning>
- Official Temporal CLI worker command reference: <https://docs.temporal.io/cli/worker>
- Official CLI releases: <https://github.com/temporalio/cli/releases>
