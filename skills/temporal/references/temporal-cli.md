# Temporal CLI quick reference

## Connection defaults

```bash
export TEMPORAL_ADDRESS=localhost:7233
export TEMPORAL_NAMESPACE=default
```

Optional per repo:

```bash
export TEMPORAL_TASK_QUEUE=bumba
```

Use `--address` / `--namespace` flags to override if you cannot set env vars.

## Workflow discovery

List recent workflows:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow list --limit 20
```

Filter by type/status:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow list \
  --query 'WorkflowType="enrichRepository" and ExecutionStatus="Running"'
```

Count workflows:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow count \
  --query 'WorkflowType="enrichFile" and ExecutionStatus="Failed"'
```

## Inspect a workflow

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow describe \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID"
```

Fetch history as JSON (for replay analysis):

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow show \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID" \
  --output json > /tmp/workflow-history.json
```

Stream live progress:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow trace \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID"
```

## Start workflows

Start a workflow:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow start \
  --workflow-type enrichRepository \
  --task-queue "$TEMPORAL_TASK_QUEUE" \
  --workflow-id "bumba-repo-$(uuidgen | tr '[:upper:]' '[:lower:]')" \
  --input '{"repoRoot":"/workspace/lab","pathPrefix":"services","maxFiles":50}'
```

Get the result (blocking):

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow result \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID"
```

## Control workflows

Cancel:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow cancel --workflow-id "$WORKFLOW_ID"
```

Terminate:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow terminate \
  --workflow-id "$WORKFLOW_ID" \
  --reason "manual cleanup"
```

Signal:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow signal \
  --workflow-id "$WORKFLOW_ID" \
  --name "signalName" \
  --input '{}'
```

## Reset workflows

Use `workflow show` to identify the event ID to reset to, then:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" workflow reset \
  --workflow-id "$WORKFLOW_ID" \
  --run-id "$RUN_ID" \
  --reason "reset to known-good event" \
  --event-id "$EVENT_ID" \
  --reset-type FirstWorkflowTask
```

## Task queue / worker visibility

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" task-queue describe \
  --task-queue "$TEMPORAL_TASK_QUEUE"
```

List task queue partitions:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" task-queue list-partition \
  --task-queue "$TEMPORAL_TASK_QUEUE"
```

## Schedules

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" schedule list
```

Describe schedule:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" schedule describe --schedule-id "$SCHEDULE_ID"
```

## Batch operations

Start a batch job for a query:

```bash
temporal --namespace "$TEMPORAL_NAMESPACE" batch start \
  --query 'WorkflowType="enrichFile" and ExecutionStatus="Failed"' \
  --reason "bulk cleanup" \
  --terminate
```

## Namespaces

```bash
temporal namespace list
```
