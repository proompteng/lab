# Temporal Bun SDK - Schedules and Typed Search Attributes

## Goal
Expose a Schedule client and typed search-attribute helpers that are safer and
more ergonomic than the TypeScript SDK while remaining fully compatible with
Temporal server behavior.

## Non-Goals
- Building a GUI for schedule management.
- Replacing Temporal CLI schedule commands.

## Requirements
1. Before implementation, check out `https://github.com/temporalio/sdk-core` and
   `https://github.com/temporalio/sdk-typescript` to confirm upstream behavior.
2. Full Schedule API: create, describe, update, patch, list, delete, trigger,
   backfill, pause, unpause, list-matching-times.
3. Typed Search Attributes for workflows and schedules.
4. Schema validation at runtime (Effect Schema) and compile-time typings.
5. Preserve compatibility with raw `SearchAttributes` payloads.
6. Support SearchAttribute updates inside workflow execution options.

## API Sketch
```ts
import { ScheduleClient, defineSearchAttributes } from '@proompteng/temporal-bun-sdk/schedule'

const sa = defineSearchAttributes({
  Team: 'keyword',
  Commit: 'text',
  BuildIds: 'keyword_list',
})

const schedule = await ScheduleClient.create({
  scheduleId: 'nightly',
  spec: { intervals: [{ everyMs: 24 * 60 * 60 * 1000 }] },
  action: {
    workflowType: 'indexRepo',
    taskQueue: 'bumba',
    args: ['repo://acme/project'],
    typedSearchAttributes: sa.encode({ Team: 'ai', BuildIds: ['v1'] }),
  },
})

await schedule.trigger({ overlap: 'ALLOW_ALL' })
```

## Data Model
- Typed SA definitions are a small DSL mapping keys to Temporal SA types.
- `encode` and `decode` run through the configured DataConverter to avoid
  divergence from workflow payload behavior.

## Implementation Notes
- Leverage the generated schedule protos in `workflowservice/v1`.
- Provide a `ScheduleHandle` with methods mirroring the server RPCs.
- Add `client.searchAttributes` convenience helpers for non-schedule APIs.

## Acceptance Criteria
- Can round-trip typed SAs without losing type info.
- Schedule update preserves conflict tokens and supports optimistic concurrency.
- Compatibility with raw `SearchAttributes` request fields.
