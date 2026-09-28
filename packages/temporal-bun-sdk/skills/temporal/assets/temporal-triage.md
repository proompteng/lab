# Temporal triage template

## Context

- UI URL: http://temporal/namespaces/default/workflows/my-workflow-id/01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22/history
- Namespace: default
- Task queue: my-task-queue
- Workflow type: MyWorkflow
- Workflow ID: my-workflow-id
- Run ID: 01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22

## Failure snapshot

- Failure summary: workflow stalled or replay mismatch
- Last event ID: <event-id>
- Worker build ID/image tag: <build-id>

Common cause: workflow code changed in a way that altered command ordering for in-flight runs
(e.g., reordered `activities.schedule(...)` without versioning guards).

## Diagnostics

- Describe: `temporal workflow describe --workflow-id my-workflow-id --run-id 01f0fdc1-b5f2-7f11-b8b5-0dc1f9a91a22`
- History JSON: `/tmp/workflow-history.json`
- Worker logs: `<your log source>`
- Replay summary: `bunx temporal-bun replay --history-file /tmp/workflow-history.json --workflow-type MyWorkflow --json`

## Mitigation

- Identify a safe reset event (often the last `WorkflowTaskCompleted` before divergence), then reset.
- If replay mismatch reproduces, patch workflow determinism and deploy a new compatible build.
- Re-run workflow and confirm child workflows complete.
