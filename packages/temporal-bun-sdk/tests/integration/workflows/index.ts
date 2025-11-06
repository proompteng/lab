import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { defineWorkflow } from '../../../src/workflow/definition'

const timerInputSchema = Schema.Struct({
  timeoutMs: Schema.optional(Schema.Number),
})

const activityInputSchema = Schema.Struct({
  value: Schema.String,
})

const childInputSchema = Schema.Struct({
  value: Schema.String,
})

const continueInputSchema = Schema.Struct({
  iterations: Schema.optional(Schema.Number),
  counter: Schema.optional(Schema.Number),
})

export const timerWorkflow = defineWorkflow('integrationTimerWorkflow', timerInputSchema, ({ timers, input }) =>
  timers
    .start({ timeoutMs: input.timeoutMs ?? 1000 })
    .pipe(Effect.map(() => 'timer-scheduled')),
)

export const activityWorkflow = defineWorkflow(
  'integrationActivityWorkflow',
  activityInputSchema,
  ({ activities, input }) =>
    activities
      .schedule('integrationEchoActivity', [input.value])
      .pipe(Effect.map(() => 'activity-scheduled')),
)

export const childWorkflow = defineWorkflow(
  'integrationChildWorkflow',
  childInputSchema,
  ({ input }) => Effect.succeed(`child:${input.value}`),
)

export const parentWorkflow = defineWorkflow(
  'integrationParentWorkflow',
  childInputSchema,
  ({ childWorkflows, input }) =>
    childWorkflows
      .start('integrationChildWorkflow', [input.value])
      .pipe(Effect.map(() => 'child-started')),
)

export const continueAsNewWorkflow = defineWorkflow(
  'integrationContinueAsNewWorkflow',
  continueInputSchema,
  ({ input, continueAsNew }) => {
    const iterations = input.iterations ?? 1
    const counter = input.counter ?? 0
    if (iterations <= 1) {
      return Effect.succeed(counter + 1)
    }
    return continueAsNew({
      workflowType: 'integrationContinueAsNewWorkflow',
      input: [{ iterations: iterations - 1, counter: counter + 1 }],
    })
  },
)

export const integrationWorkflows = [
  timerWorkflow,
  activityWorkflow,
  childWorkflow,
  parentWorkflow,
  continueAsNewWorkflow,
]

export const integrationActivities = {
  integrationEchoActivity: async (value: unknown) => value,
}
