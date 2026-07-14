---
name: temporal
description: 'Operate Temporal workflows in this repo: start, list, inspect, debug, cancel, terminate, and verify Worker Deployment routing.'
---

# Temporal

## Connection

```bash
export TEMPORAL_ADDRESS=temporal-grpc.ide-newton.ts.net:7233
export TEMPORAL_NAMESPACE=default
```

Always pass the namespace and address explicitly.

## Inspect workflows

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

## Start Atlas reconciliation

```bash
bun run atlas:rebuild --repository proompteng/lab --ref main
```

This starts one full current-main reconciliation and waits for its result. Per-file and partial-repository workflow
entrypoints no longer exist. Do not start a second rebuild while a live one can still write.

## Verify Worker Deployment routing

```bash
bun run packages/scripts/src/jangar/sync-temporal-routing.ts \
  --address "$TEMPORAL_ADDRESS" \
  --namespace "$TEMPORAL_NAMESPACE" \
  --task-queue bumba \
  --deployment-name bumba-deployment \
  --dry-run
```

Bumba and Jangar start their poller, select their exact configured build, and wait for
`routingConfigUpdateState=COMPLETED` before readiness. The repository's pinned Temporal CLI predates Worker Deployment
poller APIs; use the SDK-backed sync command for routing. The CLI remains valid for workflow inspection and migration.

Delete a stale Worker Deployment version only after proving that it is not current or ramping, is drained, and has zero
pinned workflows. Never bypass the propagation gate.

## Cancel or terminate

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

## Failure interpretation

- No workflow-task start: routing or poller failure.
- `ScheduleToStart` timeout: task-queue routing failure.
- Heartbeat timeout after worker exit: crash detection; the activity should retry with its last details.
- Running activity with heartbeat timeout `0` after a worker death: pre-hardening dead attempt; prove it is dead, terminate
  that exact run, deploy the current worker, and start one reconciliation.
- Nondeterminism: inspect history and `docs/temporal-nondeterminism.md`; reset only to a proven safe event.

## Resources

- Reference: `references/temporal-cli.md`
- Runner: `scripts/temporal-run.sh`
- Triage template: `assets/temporal-triage.md`
- Bumba incidents: `docs/runbooks/bumba-temporal-failure-modes.md`
