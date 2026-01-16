# Temporal Bun SDK - Testing Environment

## Goal
Provide a Bun-native testing harness equivalent to (and simpler than) the
TypeScript SDK test environment. It must allow deterministic, fast integration
runs with optional time skipping.

## Non-Goals
- Implementing a new Temporal test server binary.
- Replacing Temporal CLI dev server in production workflows.

## Requirements
1. Before implementation, check out `https://github.com/temporalio/sdk-core` and
   `https://github.com/temporalio/sdk-typescript` to confirm upstream behavior.
2. One-line setup for tests (Bun test, Vitest, or custom harness).
3. Optional time skipping (when server supports test service).
4. Ephemeral server lifecycle management (start/stop/health).
5. Namespace isolation and cleanup.
6. Built-in helpers for workflow start, signal, query, update, and replay.
7. Works with existing `createWorker` and `runWorkerApp` APIs.

## API Sketch
```ts
import { TestWorkflowEnvironment } from '@proompteng/temporal-bun-sdk/testing'

const env = await TestWorkflowEnvironment.createTimeSkipping({
  server: { type: 'dev', address: '127.0.0.1:7233' },
  namespace: 'test-namespace',
})

const worker = await env.createWorker({
  workflowsPath: new URL('./workflows/index.ts', import.meta.url).pathname,
  activities,
})

await worker.runUntil(async () => {
  const handle = await env.client.workflow.start({
    workflowType: 'myWorkflow',
    taskQueue: env.taskQueue,
    args: [42],
  })
  return handle.result()
})

await env.shutdown()
```

## Configuration
- `TEMPORAL_TEST_SERVER` (boolean) - prefer test service if available.
- `TEMPORAL_TEST_SERVER_PATH` - optional local test server binary.
- `TEMPORAL_TEST_NAMESPACE` - override namespace.
- `TEMPORAL_TEST_TIME_SKIPPING` - enable time skipping when supported.

## Implementation Notes
- Reuse existing `runTemporalCliEffect` and config layers for shared setup.
- Use `GetSystemInfo` to detect test service support.
- Provide a single `TestWorkflowEnvironment` class with
  `createLocal`, `createTimeSkipping`, `createExistingServer` helpers.

## Acceptance Criteria
- Tests can create and destroy environments without leaking processes.
- Time skipping advances timers and workflow sleeps deterministically.
- Worker startup is < 2s in local dev for common workflows.
- Works with determinism markers and replay fixtures.
