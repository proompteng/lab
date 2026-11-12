import { Clock, Context, Effect, Schema } from 'effect'

import type { OperationalError } from '../errors'
import { Sha256Schema, UtcInstantSchema } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { evaluateAdmittedJevBatch, JevBatchStore, type JevBatchAdmission } from './batch-evaluation'
import type { JevObservation, RestoredJevObservation } from './observation'

const JobIdentity = {
  jobId: Sha256Schema,
  batchId: Sha256Schema,
  cycleId: Sha256Schema,
  authorityGenerationHash: Sha256Schema,
  expiresAt: UtcInstantSchema,
  admissionDeadlineAt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
}

export const JevInferenceJobSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.jev-inference-job.v1'),
  ...JobIdentity,
  status: Schema.Literals(['Prepared', 'Claimed']),
})
export type JevInferenceJob = typeof JevInferenceJobSchema.Type

export const JevInferenceCompletionSchema = Schema.Union([
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.jev-inference-completion.v1'),
    ...JobIdentity,
    completedAt: UtcInstantSchema,
    status: Schema.Literal('Pending'),
  }),
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.jev-inference-completion.v1'),
    ...JobIdentity,
    completedAt: UtcInstantSchema,
    status: Schema.Literal('Completed'),
    resultHash: Sha256Schema,
  }),
])
export type JevInferenceCompletion = typeof JevInferenceCompletionSchema.Type

export interface JevInferenceRecoverySummary {
  readonly sealed: number
  readonly failed: number
  readonly remaining: boolean
  readonly nextAttemptAt?: string
}

export class JevInferenceWorkStore extends Context.Service<
  JevInferenceWorkStore,
  {
    readonly pending: (authorityGenerationHash?: string) => Effect.Effect<readonly JevInferenceJob[], OperationalError>
    readonly settleExpired: (accountId: string) => Effect.Effect<JevInferenceRecoverySummary, OperationalError>
    readonly read: (jobId: string) => Effect.Effect<JevInferenceJob | null, OperationalError>
    readonly resume: (
      cycleId: string,
      authorityGenerationHash: string,
    ) => Effect.Effect<{ readonly batchId: string; readonly source: RestoredJevObservation } | null, OperationalError>
    readonly claim: (jobId: string) => Effect.Effect<
      {
        readonly job: JevInferenceJob
        readonly admission: JevBatchAdmission
        readonly observation: JevObservation
      } | null,
      OperationalError
    >
  }
>()('@proompteng/bayn/JevInferenceWorkStore') {}

/**
 * Claiming is a one-way expense boundary. A replay may finish committed evidence,
 * but cannot repeat a provider call whose outcome was lost with the worker.
 */
export const executeJevInferenceWork = <E = never, R = never>(
  jobId: string,
  allowDispatch: Effect.Effect<boolean, E, R> = Effect.succeed(true),
) =>
  Effect.gen(function* () {
    const work = yield* JevInferenceWorkStore
    const job = yield* work.read(jobId)
    if (job === null) return null
    const claimed = (yield* allowDispatch) ? yield* work.claim(jobId) : null
    const batches = yield* JevBatchStore
    const evidence =
      claimed === null
        ? yield* batches.finish(job.batchId)
        : yield* evaluateAdmittedJevBatch(
            claimed.admission,
            claimed.observation,
            job.admissionDeadlineAt === undefined ? {} : { admissionDeadlineAt: job.admissionDeadlineAt },
          )
    const identity = {
      schemaVersion: 'bayn.jev-inference-completion.v1' as const,
      jobId: job.jobId,
      batchId: job.batchId,
      cycleId: job.cycleId,
      authorityGenerationHash: job.authorityGenerationHash,
      expiresAt: job.expiresAt,
      ...(job.admissionDeadlineAt === undefined ? {} : { admissionDeadlineAt: job.admissionDeadlineAt }),
      completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
    }
    return evidence.result === null
      ? { ...identity, status: 'Pending' as const }
      : { ...identity, status: 'Completed' as const, resultHash: evidence.result.resultHash }
  })
