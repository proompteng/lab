---
name: temporal
description: 'Operate Temporal workflows with explicit namespace/address: inspect runs, fetch history, debug nondeterminism, reset/cancel/terminate, and inspect task queues.'
---

# Temporal

## Overview

Use explicit namespace, address, and task queue variables for every command so diagnostics are repeatable.

## Connection

```bash
export TEMPORAL_ADDRESS=127.0.0.1:7233
export TEMPORAL_NAMESPACE=default
export TEMPORAL_TASK_QUEUE=my-task-queue
```

Validate connectivity:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow list --limit 5
```

If your shell environment already has these values, use `scripts/temporal-run.sh` to avoid repeating flags.

## From UI URL to CLI args

Example UI URL:

```
http://temporal/namespaces/default/workflows/my-workflow-id/01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22/history
```

Derive:

```bash
export WORKFLOW_ID=my-workflow-id
export RUN_ID=01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22
```

## Inspect workflows

Describe:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow describe \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID"
```

History (JSON):

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow show \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID" \
  --output json > /tmp/workflow-history.json
```

Trace:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow trace \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID"
```

## List and filter

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow list --limit 20

temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow list \
  --query 'WorkflowType="MyWorkflow" and ExecutionStatus="Running"'

temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow list \
  --query 'ExecutionStatus="Failed"'
```

## Replay and nondeterminism triage

1. Fetch workflow history JSON.
2. Replay with your worker code.
3. Compare mismatch location to the command stream.
4. If needed, reset to a safe event.

```bash
bunx temporal-bun replay \
  --history-file /tmp/workflow-history.json \
  --workflow-type MyWorkflow \
  --json
```

## Reset nondeterminism

1. Use `workflow show` to locate the last good event ID.
2. Reset to `FirstWorkflowTask` or a known-safe event.
3. Confirm the new run replays deterministically.

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow reset \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID" \
  --reason "reset to known-good event" \
  --event-id 31 \
  --reset-type FirstWorkflowTask
```

## Cancel and terminate

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow cancel \
  --workflow-id "$WORKFLOW_ID"

temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow terminate \
  --workflow-id "$WORKFLOW_ID" \
  --reason "manual cleanup"
```

## Task queues and workers

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" task-queue describe \
  --task-queue "$TEMPORAL_TASK_QUEUE"
```

## Resources

- Reference: `references/temporal-cli.md`
- Runner: `scripts/temporal-run.sh`
- Triage template: `assets/temporal-triage.md`
