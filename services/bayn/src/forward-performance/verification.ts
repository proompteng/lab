import { Worker } from 'node:worker_threads'
import { Context, Data, Effect, Exit, Layer, Queue, type Result } from 'effect'

import {
  InferenceCostError,
  type DecodedInferenceCostEvidence,
  type DecodedInferenceCostRequest,
} from '../inference-costs'
import type { InferenceExpenseQuote, verifyInferenceExpenseCoverage } from '../inference-expense'
import type { CycleDecisionRow } from './postgres/model'
import type { indexExecutionEvidence } from './postgres/projection'
import type { ForwardPerformanceExecutionEvidence } from './model'

export const reportVerificationConcurrency = 8

export interface ReportDecisionProjection {
  readonly executionEvidence: readonly ForwardPerformanceExecutionEvidence[]
  readonly unverifiedDecisionHashes: readonly string[]
}

export type ReportDecisionIndex = ReturnType<typeof indexExecutionEvidence>

export enum ReportVerificationTask {
  Decision = 'DECISION',
  Inference = 'INFERENCE',
  Coverage = 'COVERAGE',
}

export interface ReportExpenseCoverageInput {
  readonly evidence: DecodedInferenceCostEvidence
  readonly accountId: string
  readonly frozen: readonly { readonly quote: InferenceExpenseQuote; readonly verifiedAt: string | null }[]
  readonly authorityGenerationHash?: string
}

export type ReportExpenseCoverage = Result.Result.Success<ReturnType<typeof verifyInferenceExpenseCoverage>>

export type ReportVerificationInput =
  | {
      readonly task: ReportVerificationTask.Decision
      readonly row: typeof CycleDecisionRow.Type
      readonly index?: ReportDecisionIndex
    }
  | { readonly task: ReportVerificationTask.Inference; readonly input: unknown; readonly asOf: string }
  | { readonly task: ReportVerificationTask.Coverage; readonly input: ReportExpenseCoverageInput }

export interface ReportVerificationJob {
  readonly id: number
  readonly input: ReportVerificationInput
}

export type ReportVerificationReply = { readonly id: number } & (
  | { readonly outcome: 'DECISION'; readonly value: ReportDecisionProjection }
  | { readonly outcome: 'INFERENCE'; readonly value: DecodedInferenceCostRequest }
  | { readonly outcome: 'COVERAGE'; readonly value: ReportExpenseCoverage }
  | { readonly outcome: 'INVALID_INFERENCE'; readonly message: string; readonly cause: unknown }
  | { readonly outcome: 'DEFECT'; readonly cause: unknown }
)

export class ReportVerificationError extends Data.TaggedError('ReportVerificationError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface Slot {
  worker: Worker | undefined
  unhealthy: boolean
  decisionIndex: ReportDecisionIndex | undefined
}

const failed = (message: string, cause?: unknown) => new ReportVerificationError({ message, cause })

export const makeReportVerification = (
  spawn = () =>
    new Worker(
      new URL(
        import.meta.url.endsWith('.ts')
          ? '../forward-performance-verification-worker.ts'
          : './forward-performance-verification-worker.js',
        import.meta.url,
      ),
      {
        name: 'bayn-report-verification',
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      },
    ),
) =>
  Effect.gen(function* () {
    const slots = Array.from(
      { length: reportVerificationConcurrency },
      (): Slot => ({
        worker: undefined,
        unhealthy: false,
        decisionIndex: undefined,
      }),
    )
    const available = yield* Queue.bounded<Slot>(slots.length)
    yield* Queue.offerAll(available, slots)
    let closed = false
    let nextId = 0
    const dispose = (slot: Slot) =>
      Effect.promise(async () => {
        const worker = slot.worker
        slot.worker = undefined
        slot.decisionIndex = undefined
        if (worker !== undefined) {
          await worker.terminate()
          worker.removeAllListeners()
        }
        slot.unhealthy = false
      })
    yield* Effect.addFinalizer(() => {
      closed = true
      return Effect.forEach(slots, dispose, { concurrency: reportVerificationConcurrency, discard: true })
    })
    const run = (input: ReportVerificationInput) =>
      Effect.acquireUseRelease(
        Queue.take(available),
        (slot) =>
          Effect.gen(function* () {
            if (closed) return yield* failed('Report verification scope is closed')
            if (slot.unhealthy || slot.worker?.threadId === -1) yield* dispose(slot)
            if (slot.worker === undefined) {
              slot.worker = yield* Effect.try({
                try: spawn,
                catch: (cause) => failed('Report verification worker could not start', cause),
              })
              slot.worker.on('error', () => {
                slot.unhealthy = true
              })
              slot.worker.on('exit', () => {
                slot.unhealthy = true
              })
            }
            const worker = slot.worker
            const id = nextId++
            return yield* Effect.callback<ReportVerificationReply, ReportVerificationError>((resume) => {
              const cleanup = () => {
                worker.off('message', message)
                worker.off('error', error)
                worker.off('exit', exit)
              }
              const message = (reply: ReportVerificationReply) => {
                cleanup()
                resume(
                  reply?.id === id
                    ? Effect.succeed(reply)
                    : Effect.fail(failed('Report verification worker returned a different job')),
                )
              }
              const error = (cause: Error) => {
                cleanup()
                resume(Effect.fail(failed('Report verification worker failed', cause)))
              }
              const exit = (code: number) => {
                cleanup()
                resume(Effect.fail(failed('Report verification worker exited without a result', { code })))
              }
              worker.once('message', message)
              worker.once('error', error)
              worker.once('exit', exit)
              try {
                if (slot.unhealthy || worker.threadId === -1) {
                  cleanup()
                  resume(Effect.fail(failed('Report verification worker is unavailable')))
                } else {
                  // The immutable report cut is installed once per worker, rather than cloned for every decision.
                  const transferred =
                    input.task === ReportVerificationTask.Decision && input.index === slot.decisionIndex
                      ? { task: input.task, row: input.row }
                      : input
                  worker.postMessage({ id, input: transferred } satisfies ReportVerificationJob)
                  if (input.task === ReportVerificationTask.Decision) slot.decisionIndex = input.index
                }
              } catch (cause) {
                cleanup()
                resume(Effect.fail(failed('Report verification worker could not receive the job', cause)))
              }
              return Effect.sync(cleanup)
            }).pipe(
              Effect.flatMap((reply) =>
                reply.outcome === 'DEFECT'
                  ? Effect.die(reply.cause)
                  : (input.task === ReportVerificationTask.Decision && reply.outcome === 'DECISION') ||
                      (input.task === ReportVerificationTask.Coverage &&
                        (reply.outcome === 'COVERAGE' || reply.outcome === 'INVALID_INFERENCE')) ||
                      (input.task === ReportVerificationTask.Inference &&
                        (reply.outcome === 'INFERENCE' || reply.outcome === 'INVALID_INFERENCE'))
                    ? Effect.succeed(reply)
                    : Effect.fail(failed('Report verification worker returned the wrong task')),
              ),
            )
          }),
        (slot, exit) =>
          (Exit.isFailure(exit) ? dispose(slot) : Effect.void).pipe(Effect.ensuring(Queue.offer(available, slot))),
      )
    return {
      decision: (row: typeof CycleDecisionRow.Type, index: ReturnType<typeof indexExecutionEvidence>) =>
        run({ task: ReportVerificationTask.Decision, row, index }).pipe(
          Effect.flatMap((reply) =>
            reply.outcome === 'DECISION'
              ? Effect.succeed(reply.value)
              : Effect.fail(failed('Report verification omitted its decision projection')),
          ),
        ),
      inference: (input: unknown, asOf: string) =>
        run({ task: ReportVerificationTask.Inference, input, asOf }).pipe(
          Effect.flatMap(
            (reply): Effect.Effect<DecodedInferenceCostRequest, InferenceCostError | ReportVerificationError> =>
              reply.outcome === 'INFERENCE'
                ? Effect.succeed(reply.value)
                : reply.outcome === 'INVALID_INFERENCE'
                  ? Effect.fail(new InferenceCostError({ message: reply.message, cause: reply.cause }))
                  : Effect.fail(failed('Report verification omitted its inference evidence')),
          ),
        ),
      coverage: (input: ReportExpenseCoverageInput) =>
        run({ task: ReportVerificationTask.Coverage, input }).pipe(
          Effect.flatMap(
            (reply): Effect.Effect<ReportExpenseCoverage, InferenceCostError | ReportVerificationError> =>
              reply.outcome === 'COVERAGE'
                ? Effect.succeed(reply.value)
                : reply.outcome === 'INVALID_INFERENCE'
                  ? Effect.fail(new InferenceCostError({ message: reply.message, cause: reply.cause }))
                  : Effect.fail(failed('Report verification omitted its expense coverage')),
          ),
        ),
    }
  })

export class ReportVerification extends Context.Service<
  ReportVerification,
  Effect.Success<ReturnType<typeof makeReportVerification>>
>()('bayn/ReportVerification') {}

export const ReportVerificationLive = Layer.effect(ReportVerification, makeReportVerification())
