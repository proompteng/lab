import { Effect } from 'effect'
import * as Schema from 'effect/Schema'

import { defineWorkflow, defineWorkflowUpdates } from '../../../src/workflow/definition'
import { WorkflowBlockedError } from '../../../src/workflow/errors'
import { currentActivityContext } from '../../../src/worker/activity-context'

const cpuWorkflowInputSchema = Schema.Struct({
  rounds: Schema.Number,
  computeIterations: Schema.Number,
  timerDelayMs: Schema.Number,
})

const activityWorkflowInputSchema = Schema.Struct({
  bursts: Schema.Number,
  computeIterations: Schema.Number,
  activityDelayMs: Schema.Number,
  payloadBytes: Schema.Number,
})

const updateWorkflowInputSchema = Schema.Struct({
  cycles: Schema.Number,
  holdMs: Schema.Number,
  delayMs: Schema.Number,
})

const MIN_TIMER_DELAY_MS = 25
const MIN_ACTIVITY_DELAY_MS = 50
const MIN_ACTIVITY_PAYLOAD_BYTES = 256

export type WorkerLoadCpuWorkflowInput = Schema.Schema.Type<typeof cpuWorkflowInputSchema>
export type WorkerLoadActivityWorkflowInput = Schema.Schema.Type<typeof activityWorkflowInputSchema>
export type WorkerLoadUpdateWorkflowInput = Schema.Schema.Type<typeof updateWorkflowInputSchema>

export const workerLoadCpuWorkflow = defineWorkflow(
  'workerLoadCpuWorkflow',
  cpuWorkflowInputSchema,
  ({ input, timers }) =>
    Effect.gen(function* () {
      const rounds = Math.max(1, Math.trunc(input.rounds))
      const computeIterations = Math.max(1, Math.trunc(input.computeIterations))
      const delayMs = Math.max(MIN_TIMER_DELAY_MS, Math.trunc(input.timerDelayMs))
      let checksum = busyLoop(computeIterations, 0)
      for (let round = 0; round < rounds; round += 1) {
        checksum = busyLoop(computeIterations + round * 17, checksum)
        yield* timers.start({ timeoutMs: delayMs })
      }
      return {
        rounds,
        checksum,
      }
    }),
)

export const workerLoadActivityWorkflow = defineWorkflow(
  'workerLoadActivityWorkflow',
  activityWorkflowInputSchema,
  ({ activities, input }) =>
    Effect.gen(function* () {
      const bursts = Math.max(1, Math.trunc(input.bursts))
      const computeIterations = Math.max(1, Math.trunc(input.computeIterations))
      const activityDelayMs = Math.max(MIN_ACTIVITY_DELAY_MS, Math.trunc(input.activityDelayMs))
      const payloadBytes = Math.max(MIN_ACTIVITY_PAYLOAD_BYTES, Math.trunc(input.payloadBytes))
      let checksum = 0
      for (let burst = 0; burst < bursts; burst += 1) {
        checksum = busyLoop(computeIterations + burst * 13, checksum ^ burst)
        const heartbeatTimeoutMs = Math.max(2_000, activityDelayMs * 2)
        const startToCloseTimeoutMs = Math.max(5_000, activityDelayMs * 6)
        const scheduleToCloseTimeoutMs = Math.max(startToCloseTimeoutMs * 2, activityDelayMs * 12)
        yield* activities.schedule(
          'workerLoad.ioBurstActivity',
          [
            {
              burst,
              payloadBytes,
              delayMs: activityDelayMs,
            },
          ],
          {
            heartbeatTimeoutMs,
            startToCloseTimeoutMs,
            scheduleToCloseTimeoutMs,
          },
        )
      }
      return {
        bursts,
        checksum,
      }
    }),
)

const updatePlaceholder = () => Effect.fail(new Error('worker load update handler not bound'))

const workerLoadUpdateDefinitions = defineWorkflowUpdates([
  {
    name: 'workerLoad.setStatus',
    input: Schema.Struct({ status: Schema.String }),
    handler: () => updatePlaceholder(),
  },
  {
    name: 'workerLoad.delayedSetStatus',
    input: Schema.Struct({ status: Schema.String, delayMs: Schema.optional(Schema.Number) }),
    handler: () => updatePlaceholder(),
  },
  {
    name: 'workerLoad.guardStatus',
    input: Schema.Struct({ level: Schema.Number }),
    handler: () => updatePlaceholder(),
  },
])

export const workerLoadUpdateWorkflow = defineWorkflow(
  'workerLoadUpdateWorkflow',
  updateWorkflowInputSchema,
  ({ input, timers, updates }) =>
    Effect.gen(function* () {
      let status = 'booting'
      const [setStatusDef, delayedStatusDef, guardStatusDef] = workerLoadUpdateDefinitions

      updates.register(setStatusDef, (_ctx, payload: { status: string }) =>
        Effect.sync(() => {
          status = payload.status
          return status
        }),
      )

      updates.register(
        delayedStatusDef,
        ({ timers: timerContext }, payload: { status: string; delayMs?: number }) =>
          timerContext
            .start({ timeoutMs: Math.max(50, Math.trunc(payload.delayMs ?? input.delayMs)) })
            .pipe(
              Effect.map(() => {
                status = payload.status
                return status
              }),
            ),
      )

      updates.register(
        guardStatusDef,
        (_ctx, payload: { level: number }) =>
          Effect.sync(() => {
            status = `level-${payload.level}`
            return status
          }),
        {
          validator: (payload) => {
            if (!Number.isFinite(payload.level) || payload.level < 0) {
              throw new Error('status-level-invalid')
            }
          },
        },
      )

      const cycles = Math.max(1, Math.trunc(input.cycles))
      const holdMs = Math.max(100, Math.trunc(input.holdMs))
      for (let index = 0; index < cycles; index += 1) {
        yield* timers.start({ timeoutMs: holdMs })
      }

      yield* Effect.fail(new WorkflowBlockedError('worker-load-updates'))
    }),
  { updates: workerLoadUpdateDefinitions },
)

type IoBurstActivityInput = {
  burst: number
  payloadBytes: number
  delayMs: number
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const burstDigest = (buffer: Buffer): number => {
  let digest = 0
  for (let index = 0; index < buffer.length; index += 64) {
    digest = (digest + buffer[index]) % 65_521
  }
  return digest
}

const ioBurstActivity = async (input: IoBurstActivityInput): Promise<{ burst: number; digest: number; samples: number }> => {
  const ctx = currentActivityContext()
  const payload = Buffer.alloc(Math.max(MIN_ACTIVITY_PAYLOAD_BYTES, input.payloadBytes), input.burst % 255)
  const start = Date.now()
  const deadline = start + Math.max(MIN_ACTIVITY_DELAY_MS, input.delayMs)
  const sleepSlice = Math.max(25, Math.min(250, Math.trunc(input.delayMs / 4) || 50))
  let samples = 0
  while (Date.now() < deadline) {
    samples += 1
    if (ctx) {
      await ctx.heartbeat({ burst: input.burst, samples })
      ctx.throwIfCancelled()
    }
    await sleep(sleepSlice)
  }
  return {
    burst: input.burst,
    digest: burstDigest(payload),
    samples,
  }
}

const busyLoop = (iterations: number, seed: number): number => {
  const target = Math.max(1, iterations)
  let state = seed >>> 0
  for (let index = 0; index < target; index += 1) {
    state = Math.imul(state ^ (index * 31 + 0x9e3779b1), 0x85ebca6b) >>> 0
    if (index % 2_048 === 0) {
      state = (state + 0xc2b2ae35) >>> 0
    }
  }
  return state >>> 0
}

export const workerLoadWorkflows = [workerLoadCpuWorkflow, workerLoadActivityWorkflow, workerLoadUpdateWorkflow]

export const workerLoadActivities = {
  'workerLoad.ioBurstActivity': ioBurstActivity,
}
