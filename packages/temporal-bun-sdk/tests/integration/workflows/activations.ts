import { Effect, Schema } from 'effect'

import { defineWorkflow } from '../../../src/workflow/definition'
import { defineWorkflowSignals } from '../../../src/workflow/inbound'

export const caughtActivityWorkflow = defineWorkflow('integrationCaughtActivityWorkflow', ({ activities }) =>
  activities
    .schedule('integrationEchoActivity', ['activity-result'])
    .pipe(Effect.catchAllCause(() => Effect.succeed('caught-pending'))),
)

export const parallelActivityWorkflow = defineWorkflow('integrationParallelActivityWorkflow', ({ activities }) =>
  Effect.all(
    [
      activities
        .schedule('integrationEchoActivity', ['A'], { activityId: 'A' })
        .pipe(Effect.flatMap(() => activities.schedule('integrationEchoActivity', ['C'], { activityId: 'C' }))),
      activities.schedule('integrationDelayedEchoActivity', ['B', 1_000], { activityId: 'B' }),
    ],
    { concurrency: 'unbounded' },
  ),
)

const batchSignals = defineWorkflowSignals({ item: Schema.Unknown })

export const signalBatchWorkflow = defineWorkflow('integrationSignalBatchWorkflow', ({ signals, activities }) =>
  Effect.gen(function* () {
    const batch = yield* signals.drain(batchSignals.item)
    return yield* activities.schedule('integrationDelayedEchoActivity', [batch.map((item) => item.payload), 1_000])
  }),
)
