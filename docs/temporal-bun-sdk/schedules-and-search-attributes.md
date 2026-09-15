# Schedules and search attributes

The Bun SDK exposes full Temporal Schedule support plus typed search attributes
backed by Effect Schema validation.

## Schedule client

`TemporalClient.schedules` maps to WorkflowService schedule RPCs:

- `create`, `describe`, `update`, `patch`, `list`
- `delete`, `trigger`, `backfill`
- `pause`, `unpause`
- `listMatchingTimes`

Every method accepts optional `TemporalClientCallOptions` for headers, timeouts,
abort signals, and retry overrides.

```ts
const { client } = await createTemporalClient()

await client.schedules.create({
  namespace: 'default',
  scheduleId: 'daily-report',
  schedule: {
    spec: { interval: [{ interval: { seconds: 86_400 } }] },
    action: {
      action: {
        case: 'startWorkflow',
        value: { workflowType: { name: 'reportWorkflow' }, taskQueue: { name: 'reports' } },
      },
    },
  },
})
```

## Typed search attributes

Use `defineSearchAttributes()` or `client.searchAttributes.typed()` to create a
schema-backed helper. The helper encodes/decodes search attributes with the
client's `DataConverter`.

```ts
import { Schema } from 'effect'
import { defineSearchAttributes } from '@proompteng/temporal-bun-sdk'

const CustomerSearch = defineSearchAttributes({
  CustomerId: Schema.String,
  Tier: Schema.Literal('gold', 'silver', 'bronze'),
})

const typed = client.searchAttributes.typed(CustomerSearch)
const encoded = await typed.encode({ CustomerId: 'c-123', Tier: 'gold' })
const decoded = await typed.decode(encoded)
```

Validation errors surface via Effect Schema decoding, preventing invalid
search-attribute writes.
