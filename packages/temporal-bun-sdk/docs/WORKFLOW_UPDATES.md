# Workflow Updates – Quick Reference

## Registering updates
```ts
import { defineWorkflow, defineWorkflowUpdates } from '@proompteng/temporal-bun-sdk/workflow'
import * as Schema from 'effect/Schema'

const updates = defineWorkflowUpdates([
  {
    name: 'setCounter',
    input: Schema.Number,
    handler: async ({ info }, value: number) => {
      console.log('Update from', info.workflowId, 'value', value)
      return value
    },
  },
])

export const counterWorkflow = defineWorkflow(
  'counterWorkflow',
  Schema.Number,
  ({ input, updates }) => {
    let count = input

    updates.register(updates[0], async (_ctx, value) => {
      count = value
      return count
    })

    return Effect.sync(() => count)
  },
  { updates },
)
```

## Invoking updates
```ts
const result = await client.workflow.update(handle, {
  updateName: 'setCounter',
  args: [42],
  waitForStage: 'completed',
})

if (result.outcome?.status === 'success') {
  console.log('Counter updated to', result.outcome.result)
}
```

## Monitoring
- Use `temporal workflow update` CLI commands or Cloud UI to inspect update states.
- Worker logs emitted when decoding protocol messages: enable `LOG_LEVEL=debug` if you need to trace update routing.
- Determinism mismatches now show `kind: 'update'` entries referencing update IDs.
