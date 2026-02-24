# Temporal Nondeterminism: Replay Divergence

Temporal workflows must be deterministic: when a workflow task is replayed against its existing event history, the
workflow code must emit the exact same command stream (same commands, same order, same parameters).

This repo uses Temporal heavily (notably `services/bumba`). A common production failure mode is:

- UI / CLI failure: `WorkflowTaskFailed` with message `Workflow did not replay all history entries`
- Workers may spam logs about nondeterminism / sticky cache eviction
- The workflow often appears `Running` but never makes progress (no pending activities/children), or keeps retrying the
  workflow task

This is not an "activity failed" problem. It is almost always a workflow code + history mismatch.

## What Causes It

The most common cause is changing workflow code in a way that changes the command stream for in-flight executions:

- Reordering `activities.schedule(...)` calls
- Adding a new `activities.schedule(...)` before an existing schedule
- Changing activity IDs (explicitly or implicitly) by changing the number/order of scheduled commands
- Changing child workflow start order / IDs
- Emitting new timers/signals/markers on replay

Example (what happened in `enrichFile`):

1. Old code scheduled `enrichWithModel` before `persistFileVersion` / `indexFileChunks`.
2. New code scheduled `persistFileVersion` / `indexFileChunks` earlier.
3. In-flight runs already had history that said "next scheduled activity is `enrichWithModel`".
4. On replay, the new worker tried to schedule something else first, so replay diverged and Temporal failed the workflow
   task with nondeterminism.

## How To Detect It

Use the repo Temporal skill for connection defaults:

- `skills/temporal/SKILL.md`

Minimal triage:

```bash
export TEMPORAL_ADDRESS=temporal-grpc:7233
export TEMPORAL_NAMESPACE=default

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow describe \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID"

temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow show \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID" --output json > /tmp/workflow-history.json
```

Look for the pattern:

- One or more `EVENT_TYPE_WORKFLOW_TASK_FAILED` events with `failure.message` matching:
  - `Workflow did not replay all history entries`
  - or an SDK-specific nondeterminism error like "command intent mismatch during replay"

If you also see an activity failure immediately before nondeterminism (e.g. model endpoint down), that can be the
trigger that forces a replay. It is usually not the root cause.

## How To Prevent It (Correct Workflow Versioning)

When changing workflow command ordering/shape, you must gate the change behind a replay-safe version check.

In this repo (Temporal Bun SDK), use:

- `determinism.patched('some.patch.id')`
- `determinism.getVersion({ changeId, minSupported, maxSupported })`

### Pattern: `patched()`

Use when you need a boolean "old behavior vs new behavior" split.

```ts
// services/bumba/src/workflows/index.ts
defineWorkflow('someWorkflow', SomeInput, ({ determinism, activities }) => {
  return Effect.gen(function* () {
    const useNewOrdering = determinism.patched('someWorkflow.newOrdering.v1')

    if (useNewOrdering) {
      // New scheduling order (or new commands).
      yield* activities.schedule('newActivityFirst', [])
      yield* activities.schedule('existingActivity', [])
    } else {
      // Legacy scheduling order for replay of old histories.
      yield* activities.schedule('existingActivity', [])
    }
  })
})
```

Operationally:

1. Deploy with the patch branch in place and keep it until all old executions are completed or reset.
2. After you're confident no old executions need the legacy branch, you can optionally call
   `determinism.deprecatePatch('someWorkflow.newOrdering.v1')` and later remove the old branch.

### Pattern: `getVersion()`

Use when you need a numeric version (e.g. multiple migrations).

```ts
const v = determinism.getVersion({
  changeId: 'someWorkflow.migration',
  minSupported: 1,
  maxSupported: 2,
})

if (v === 1) {
  // Legacy
} else {
  // New
}
```

## How To Recover In Production

If you already have nondeterministic runs in production, you have two practical options:

1. Reset the workflow execution to a point in history before the divergence.
2. Terminate/cancel and restart (safe only if you can tolerate losing progress and/or have idempotent side effects).

### Reset Workflow (Recommended)

Use `temporal workflow show` output to identify a safe reset point.

Heuristic that works well when the divergence is "new code schedules extra commands earlier":

- Find the last `EVENT_TYPE_WORKFLOW_TASK_COMPLETED` event _before_ the first scheduled event you need to reschedule
  (e.g., before `EVENT_TYPE_ACTIVITY_TASK_SCHEDULED` for the activity that diverged).

Then reset to that event ID:

```bash
temporal --address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE" workflow reset \
  --workflow-id "$WORKFLOW_ID" --run-id "$RUN_ID" \
  --event-id "$EVENT_ID" \
  --reason "reset: workflow nondeterminism after code change"
```

Reset creates a new run ID. Re-check progress on the new run.

## Related Docs

- `skills/temporal/assets/temporal-triage.md`
- `docs/replay-runbook.md`
- `packages/temporal-bun-sdk/docs/production-design.md` (determinism guard / replay harness)
