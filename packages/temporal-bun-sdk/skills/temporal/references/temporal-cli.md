# Temporal CLI quick reference

## Connection

```bash
export TEMPORAL_ADDRESS=127.0.0.1:7233
export TEMPORAL_NAMESPACE=default
```

## List

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow list --limit 20
```

## Filter

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow list \
  --query 'WorkflowType="MyWorkflow" and ExecutionStatus="Running"'
```

## Describe, show, result

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow describe \
  --workflow-id my-workflow-id \
  --run-id 01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22

temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow show \
  --workflow-id my-workflow-id \
  --run-id 01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22 \
  --output json > /tmp/workflow-history.json

temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow result \
  --workflow-id my-workflow-id \
  --run-id 01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22
```

## Reset

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow reset \
  --workflow-id my-workflow-id \
  --run-id 01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22 \
  --event-id 31 \
  --reset-type FirstWorkflowTask \
  --reason "reset to known-good event"
```

## Cancel and terminate

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow cancel \
  --workflow-id my-workflow-id

temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" workflow terminate \
  --workflow-id my-workflow-id \
  --reason "manual cleanup"
```

## Task queues

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" task-queue describe \
  --task-queue my-task-queue
```

## Batch operations

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" batch start \
  --query 'ExecutionStatus="Failed"' \
  --reason "cleanup failed runs" \
  --terminate
```

## Schedules

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" --address "$TEMPORAL_ADDRESS" schedule list
```
