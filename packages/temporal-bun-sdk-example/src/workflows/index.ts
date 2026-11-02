import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'

export const workflows = [
  defineWorkflow('greetingWorkflow', Schema.Array(Schema.String), ({ input, activities }) =>
    Effect.gen(function* () {
      const [rawName] = input
      const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Temporal'
      const message = `Hello, ${name}!`
      console.log(`[workflow] greetingWorkflow: preparing greeting for ${name}`)

      const dispatchResult = yield* activities
        .schedule('sendGreeting', [{ to: name, message }], {
          activityId: 'send-greeting',
          startToCloseTimeoutMs: 30_000,
        })
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)))
      console.log(`[workflow] greetingWorkflow: sendGreeting result -> ${dispatchResult}`)

      const metric = yield* activities.schedule('recordMetric', ['greeting.sent', 1], {
        activityId: 'record-metric',
        startToCloseTimeoutMs: 30_000,
      })
      console.log('[workflow] greetingWorkflow: recorded metric', metric)

      return { message, dispatchResult }
    }),
  ),
]

export default workflows
