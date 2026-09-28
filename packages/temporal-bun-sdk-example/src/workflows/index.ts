import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'

import activities from '../activities/index.ts'

export const workflows = [
  defineWorkflow(
    'greetingWorkflow',
    Schema.Array(Schema.String),
    ({ input }) =>
      Effect.gen(function* () {
        const [rawName] = input
        const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Temporal'
        const message = `Hello, ${name}!`
        console.log(`[workflow] greetingWorkflow: preparing greeting for ${name}`)

        const dispatchResult = yield* Effect.promise(() => activities.sendGreeting({ to: name, message }))
        console.log(`[workflow] greetingWorkflow: sendGreeting result -> ${dispatchResult}`)

        const metric = yield* Effect.promise(() => activities.recordMetric('greeting.sent', 1))
        console.log('[workflow] greetingWorkflow: recorded metric', metric)

        return { message, dispatchResult }
      }),
  ),
]

export default workflows
