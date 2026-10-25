import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { defineWorkflow } from '../workflow'

export const workflows = [
  defineWorkflow('helloTemporal', Schema.Array(Schema.String), ({ input, activities, determinism }) => {
    const [rawName] = input
    const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Temporal'

    return Effect.flatMap(activities.schedule('recordGreeting', [name]), () =>
      Effect.sync(() => {
        const timestamp = new Date(determinism.now()).toISOString()
        return `Greeting enqueued for ${name} at ${timestamp}`
      }),
    )
  }),
]

export default workflows
