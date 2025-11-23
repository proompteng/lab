import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

const helloInput = Schema.Struct({
  name: Schema.String,
})

export const workflows = [
  defineWorkflow('helloWorkflow', helloInput, ({ input, activities }) =>
    Effect.gen(function* () {
      const greeting = yield* activities.schedule('sayHello', [input.name])
      const note = yield* activities.schedule('recordNote', [`Greeted ${input.name}`])

      return { greeting, note }
    }),
  ),
]

export default workflows
