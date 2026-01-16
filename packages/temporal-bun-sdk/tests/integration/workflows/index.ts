import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { defineWorkflow, defineWorkflowUpdates } from '../../../src/workflow/definition'
import { WorkflowBlockedError } from '../../../src/workflow/errors'
import { defineWorkflowQueries, defineWorkflowSignals } from '../../../src/workflow/inbound'
import { currentActivityContext } from '../../../src/worker/activity-context'

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

const heartbeatInputSchema = Schema.Struct({
  durationMs: Schema.Number,
  heartbeatTimeoutMs: Schema.optional(Schema.Number),
})

const heartbeatTimeoutInputSchema = Schema.Struct({
  initialBeats: Schema.optional(Schema.Number),
  stallMs: Schema.optional(Schema.Number),
  heartbeatTimeoutMs: Schema.optional(Schema.Number),
})

const retryProbeInputSchema = Schema.Struct({
  failUntil: Schema.Number,
  permanentOn: Schema.Number,
  maxAttempts: Schema.Number,
})

const updateWorkflowInputSchema = Schema.Struct({
  initialMessage: Schema.optional(Schema.String),
  cycles: Schema.optional(Schema.Number),
  holdMs: Schema.optional(Schema.Number),
})

const setMessageInputSchema = Schema.Struct({
  value: Schema.String,
})

const delayedMessageInputSchema = Schema.Struct({
  value: Schema.String,
  delayMs: Schema.optional(Schema.Number),
})

const guardedMessageInputSchema = Schema.Struct({
  value: Schema.String,
})

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

export const timerWorkflow = defineWorkflow('integrationTimerWorkflow', timerInputSchema, ({ timers, input }) =>
  timers
    .start({ timeoutMs: input.timeoutMs ?? 1_000 })
    .pipe(Effect.map(() => 'timer-scheduled')),
)

export const activityWorkflow = defineWorkflow(
  'integrationActivityWorkflow',
  activityInputSchema,
  ({ activities, input }) => activities.schedule('integrationEchoActivity', [input.value]),
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

export const heartbeatWorkflow = defineWorkflow(
  'integrationHeartbeatWorkflow',
  heartbeatInputSchema,
  ({ activities, input }) =>
    activities
      .schedule(
        'integrationHeartbeatActivity',
        [input.durationMs],
        {
          heartbeatTimeoutMs: input.heartbeatTimeoutMs ?? 400,
          startToCloseTimeoutMs: input.durationMs + 600,
        },
      )
      .pipe(Effect.map(() => 'heartbeat-complete')),
)

export const heartbeatTimeoutWorkflow = defineWorkflow(
  'integrationHeartbeatTimeoutWorkflow',
  heartbeatTimeoutInputSchema,
  ({ activities, input }) =>
    activities.schedule(
      'integrationHeartbeatTimeoutActivity',
      [
        {
          initialBeats: input.initialBeats ?? 2,
          stallMs: input.stallMs ?? 1_000,
        },
      ],
      {
        heartbeatTimeoutMs: input.heartbeatTimeoutMs ?? 300,
        startToCloseTimeoutMs: (input.stallMs ?? 1_000) + 600,
      },
    ),
)

export const retryProbeWorkflow = defineWorkflow(
  'integrationRetryProbeWorkflow',
  retryProbeInputSchema,
  ({ activities, input }) =>
    activities.schedule(
      'integrationRetryProbeActivity',
      [
        {
          failUntil: input.failUntil,
          permanentOn: input.permanentOn,
        },
      ],
      {
        retry: {
          maximumAttempts: input.maxAttempts,
          initialIntervalMs: 200,
          maximumIntervalMs: 2_000,
          backoffCoefficient: 2,
          nonRetryableErrorTypes: ['PermanentIntegrationError'],
        },
        startToCloseTimeoutMs: 10_000,
      },
    ),
)

const signalHandles = defineWorkflowSignals({
  unblock: Schema.String,
  finish: Schema.Struct({}),
})

const queryHandles = defineWorkflowQueries({
  state: {
    input: Schema.Struct({}),
    output: Schema.Struct({ message: Schema.String }),
  },
})

const queryOnlyHandles = defineWorkflowQueries({
  status: {
    input: Schema.Struct({}),
    output: Schema.String,
  },
})

export const signalQueryWorkflow = defineWorkflow({
  name: 'integrationSignalQueryWorkflow',
  signals: signalHandles,
  queries: queryHandles,
  handler: ({ signals, queries }) =>
    Effect.gen(function* () {
      let current = 'waiting'
      yield* queries.register(queryHandles.state, () => Effect.sync(() => ({ message: current })))
      const unblock = yield* signals.waitFor(signalHandles.unblock)
      current = unblock.payload
      yield* signals.waitFor(signalHandles.finish)
      return current
    }),
})

export const queryOnlyWorkflow = defineWorkflow({
  name: 'integrationQueryOnlyWorkflow',
  queries: queryOnlyHandles,
  handler: ({ timers, queries }) =>
    Effect.gen(function* () {
      let status = 'blocked-on-timer'
      yield* queries.register(queryOnlyHandles.status, () => Effect.sync(() => status))
      yield* timers.start({ timeoutMs: 30_000 })
      yield* Effect.fail(new WorkflowBlockedError('waiting-for-timer'))
      return status
    }),
})

const placeholderUpdateHandler = () => Effect.fail(new Error('workflow update handler not bound'))

const integrationUpdateDefinitions = defineWorkflowUpdates([
  {
    name: 'integrationUpdate.setMessage',
    input: setMessageInputSchema,
    handler: () => placeholderUpdateHandler(),
  },
  {
    name: 'integrationUpdate.delayedSetMessage',
    input: delayedMessageInputSchema,
    handler: () => placeholderUpdateHandler(),
  },
  {
    name: 'integrationUpdate.guardMessage',
    input: guardedMessageInputSchema,
    handler: () => placeholderUpdateHandler(),
  },
])

export const updateWorkflow = defineWorkflow(
  'integrationUpdateWorkflow',
  updateWorkflowInputSchema,
  ({ input, timers, updates }) =>
    Effect.gen(function* () {
      let message = input.initialMessage ?? 'booting'
      const cycles = Math.max(1, Math.trunc(input.cycles ?? 3))
      const holdMs = Math.max(250, Math.trunc(input.holdMs ?? 5_000))

      const [setMessageDef, delayedSetMessageDef, guardedMessageDef] = integrationUpdateDefinitions

      updates.register(setMessageDef, (_ctx, payload: Schema.Schema.Type<typeof setMessageInputSchema>) =>
        Effect.sync(() => {
          message = payload.value
          return message
        }),
      )

      updates.register(
        delayedSetMessageDef,
        ({ timers: timerContext }, payload: Schema.Schema.Type<typeof delayedMessageInputSchema>) =>
          timerContext
            .start({ timeoutMs: Math.max(100, Math.trunc(payload.delayMs ?? 1_000)) })
            .pipe(
              Effect.map(() => {
                message = payload.value
                return message
              }),
            ),
      )

      updates.register(
        guardedMessageDef,
        (_ctx, payload: Schema.Schema.Type<typeof guardedMessageInputSchema>) =>
          Effect.sync(() => {
            message = payload.value
            return message
          }),
        {
          validator: (payload) => {
            if (!payload.value || payload.value.trim().length < 3) {
              throw new Error('message-too-short')
            }
          },
        },
      )

      for (let index = 0; index < cycles; index += 1) {
        yield* timers.start({ timeoutMs: holdMs })
      }

      yield* Effect.fail(new WorkflowBlockedError('waiting-for-updates'))
    }),
  { updates: integrationUpdateDefinitions },
)

export const integrationWorkflows = [
  timerWorkflow,
  activityWorkflow,
  childWorkflow,
  parentWorkflow,
  continueAsNewWorkflow,
  heartbeatWorkflow,
  heartbeatTimeoutWorkflow,
  retryProbeWorkflow,
  signalQueryWorkflow,
  queryOnlyWorkflow,
  updateWorkflow,
]

const integrationHeartbeatActivity = async (durationMs: number): Promise<string> => {
  const ctx = currentActivityContext()
  const end = Date.now() + durationMs
  while (Date.now() < end) {
    if (ctx) {
      await ctx.heartbeat({ tick: Date.now() })
      ctx.throwIfCancelled()
    }
    await sleep(250)
  }
  return 'heartbeat-ok'
}

const integrationHeartbeatTimeoutActivity = async (options: {
  initialBeats: number
  stallMs: number
}): Promise<void> => {
  const ctx = currentActivityContext()
  for (let index = 0; index < options.initialBeats; index += 1) {
    if (ctx) {
      await ctx.heartbeat({ stage: 'warmup', beat: index })
    }
    await sleep(250)
  }
  await sleep(options.stallMs)
  ctx?.throwIfCancelled()
}

const integrationRetryProbeActivity = async (plan: {
  failUntil: number
  permanentOn: number
}): Promise<string> => {
  const ctx = currentActivityContext()
  const attempt = (ctx?.info.attempt ?? 0) + 1
  if (attempt >= plan.permanentOn) {
    const permanent = new Error('Permanent failure')
    permanent.name = 'PermanentIntegrationError'
    throw permanent
  }
  if (attempt <= plan.failUntil) {
    const retryable = new Error(`Retryable attempt ${attempt}`)
    retryable.name = 'RetryableIntegrationError'
    throw retryable
  }
  return `attempt-${attempt}`
}

export const integrationActivities = {
  integrationEchoActivity: async (value: unknown) => value,
  integrationHeartbeatActivity,
  integrationHeartbeatTimeoutActivity,
  integrationRetryProbeActivity,
}
