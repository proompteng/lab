import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { defineWorkflow } from '../workflow'

export const workflows = [
  defineWorkflow('helloTemporal', Schema.Array(Schema.String), ({ input }) =>
    Effect.sync(() => {
      const [rawName] = input
      const name = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'Temporal'
      return `Hello, ${name}!`
    }),
  ),
]

export default workflows
