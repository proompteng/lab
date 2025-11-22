import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

const codexPlanInput = Schema.Struct({
  topic: Schema.String,
  audience: Schema.optional(Schema.String),
  tone: Schema.optional(Schema.String),
})

export const workflows = [
  defineWorkflow('codexPlanningWorkflow', codexPlanInput, ({ input, activities, determinism }) =>
    Effect.gen(function* () {
      const summary = yield* activities.schedule('draftWithCodex', [
        {
          ...input,
          audience: input.audience ?? 'lab operators',
          tone: input.tone ?? 'concise',
        },
      ])
      const note = yield* activities.schedule('recordProgressNote', [
        `Generated Codex summary for ${input.topic} at ${new Date(determinism.now()).toISOString()}`,
      ])

      return {
        topic: input.topic,
        summary,
        auditNote: note,
      }
    }),
  ),
]

export default workflows
