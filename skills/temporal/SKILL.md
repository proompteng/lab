---
name: temporal
description: Operate Temporal workflows for this repo. Use when asked to start/list/inspect workflows, retrieve history/events, debug failures or nondeterminism, reset/cancel/terminate/signal workflows, or check task queues/workers via the Temporal CLI and kubectl.
---

# Temporal

## Overview

Operate and debug Temporal workflows with the CLI and cluster tooling. Keep namespace, address, and task queue explicit, and capture workflow/run IDs for any analysis or remediation.

## Quick start

1. Set connection env (example for Tailscale):

```bash
export TEMPORAL_ADDRESS=temporal-grpc.ide-newton.ts.net:7233
export TEMPORAL_NAMESPACE=default
export TEMPORAL_TASK_QUEUE=bumba
```

2. Validate connectivity:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow list --limit 5
```

3. If you have a Temporal UI URL, extract `workflowId` and `runId` from:
`/workflows/<workflowId>/<runId>/history`, then use them in CLI commands.

## Common tasks

### Inspect a workflow

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow describe \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID"
```

### Fetch history / events

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow show \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID" \
  --output json > /tmp/workflow-history.json
```

### Filter workflow lists

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow list \
  --query 'WorkflowType="enrichFile" and ExecutionStatus="Running"'
```

### Cancel / terminate / signal

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow cancel --workflow-id "$WORKFLOW_ID"
temporal --namespace "$TEMPORAL_NAMESPACE" workflow terminate --workflow-id "$WORKFLOW_ID" --reason "cleanup"
temporal --namespace "$TEMPORAL_NAMESPACE" workflow signal --workflow-id "$WORKFLOW_ID" --name "signalName" --input '{}'
```

### Reset a workflow (nondeterminism or bad state)

1. Find the event ID to reset to via `workflow show`.
2. Reset:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow reset \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID" \
  --reason "reset to known-good event" \
  --event-id "$EVENT_ID" \
  --reset-type FirstWorkflowTask
```

### Task queue / worker visibility

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" task-queue describe \
  --task-queue "$TEMPORAL_TASK_QUEUE"
```

## When to load references

Use `references/temporal-cli.md` for a fuller command cookbook (batch ops, schedules, worker/build ID management, query syntax, etc.).

---
