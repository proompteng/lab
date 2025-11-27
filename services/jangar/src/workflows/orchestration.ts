import { defineWorkflow } from '@proompteng/temporal-bun-sdk/workflow'
import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

const orchestrationInput = Schema.Struct({
  topic: Schema.String,
  repoUrl: Schema.optional(Schema.String),
  constraints: Schema.optional(Schema.String),
  depth: Schema.optional(Schema.Number),
  maxTurns: Schema.optional(Schema.Number),
})

export const workflows = [
  defineWorkflow('codexOrchestrationWorkflow', orchestrationInput, ({ input, activities }) =>
    Effect.gen(function* () {
      // TODO(jng-050a): replace stub turn with loop, signals, queries, and worker delegation
      const turnResult = yield* activities.schedule('runCodexTurnActivity', [
        {
          threadId: null,
          prompt: `Plan: ${input.topic}`,
          repoUrl: input.repoUrl ?? undefined,
          depth: input.depth,
          constraints: input.constraints,
        },
      ])

      return { turns: [turnResult], status: 'pending' as const }
    }),
  ),
]

export default workflows
