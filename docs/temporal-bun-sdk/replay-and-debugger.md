# Temporal Bun SDK - Replay and Debugger

## Goal
Provide replay tooling that is easier to use and more diagnostic than the
TypeScript SDK. This includes determinism diffs, stable fixtures, and debugger
integration.

## Non-Goals
- Building a full IDE plugin.
- Replacing the Temporal CLI history tools.

## Requirements
1. Before implementation, check out `https://github.com/temporalio/sdk-core` and
   `https://github.com/temporalio/sdk-typescript` to confirm upstream behavior.
2. Replay single history and batch histories.
3. Determinism diffs that show mismatched commands and event IDs.
4. Optional history fetch via WorkflowService (fallback to CLI).
5. Debugger entrypoint for breakpoints and step-through replay.
6. Replay-safe observability (no external side effects by default).

## API Sketch
```ts
import { replayHistory, replayHistories, startDebugReplayer } from '@proompteng/temporal-bun-sdk/replay'

await replayHistory({ historyJson, workflowsPath })

for await (const result of replayHistories({ histories, workflowsPath })) {
  console.log(result.workflowId, result.status)
}

startDebugReplayer({ workflowsPath, historyJson })
```

## Implementation Notes
- Reuse determinism marker pipeline for diff generation.
- Provide a JSON report format for CI and human inspection.
- Expose a CLI command: `temporal-bun replay --history <file>`.

## Acceptance Criteria
- Replay errors include event ID, expected command, and actual command.
- Debug replayer works with Bun inspector.
- Replay can run without a running server when history is provided.
