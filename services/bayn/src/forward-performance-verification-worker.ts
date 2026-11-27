import { parentPort } from 'node:worker_threads'
import { NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Logger, Queue, Result } from 'effect'

import { decodeInferenceCostRequest, InferenceCostError } from './inference-costs'
import { verifyInferenceExpenseCoverage } from './inference-expense'
import {
  intradayPerformanceDecisionRequest,
  makeIntradayPerformanceVolumeEvidenceBatch,
} from './forward-performance/intraday-volume'
import type { IntradaySnapshotFailure } from './market-data/intraday/model'
import { executionEvidenceFromRows, verifyPerformanceDecisionJson } from './forward-performance/postgres/projection'
import { verifyAlphaDecisionJson } from './forward-performance/postgres/alpha-decisions'
import {
  ReportVerificationTask,
  type ReportDecisionIndex,
  type ReportVerificationJob,
  type ReportVerificationReply,
} from './forward-performance/verification'

const invalidVolume = (id: number, failure: IntradaySnapshotFailure): ReportVerificationReply => {
  const { reason, message, facts, ingestionDelayDirection, cause } = failure
  return {
    id,
    outcome: 'INVALID_VOLUME',
    failure: {
      reason,
      message,
      ...(facts === undefined ? {} : { facts }),
      ...(ingestionDelayDirection === undefined ? {} : { ingestionDelayDirection }),
      ...(cause === undefined ? {} : { cause }),
    },
  }
}

export const verifyReportJob = (
  job: ReportVerificationJob,
  retainedIndex?: ReportDecisionIndex,
): ReportVerificationReply => {
  const { id, input } = job
  if (input.task === ReportVerificationTask.VolumeRequest) {
    const result = intradayPerformanceDecisionRequest(input.request)
    return Result.isSuccess(result)
      ? { id, outcome: 'VOLUME_REQUEST', value: result.success }
      : invalidVolume(id, result.failure)
  }
  if (input.task === ReportVerificationTask.Volume) {
    const result = makeIntradayPerformanceVolumeEvidenceBatch(input.requests, input.archiveRequest, input.rawBars)
    if (Result.isSuccess(result)) return { id, outcome: 'VOLUME', value: result.success }
    return invalidVolume(id, result.failure)
  }
  if (input.task === ReportVerificationTask.Decision) {
    const index = input.index ?? retainedIndex
    if (index === undefined) throw new Error('Report decision index is unavailable')
    const verified = verifyPerformanceDecisionJson(input.row)
    return {
      id,
      outcome: 'DECISION',
      value: {
        executionEvidence: executionEvidenceFromRows(verified.verifiedRows, index),
        unverifiedDecisionHashes: verified.unverifiedDecisionHashes,
      },
    }
  }
  if (input.task === ReportVerificationTask.AlphaDecision)
    return { id, outcome: 'ALPHA_DECISION', value: verifyAlphaDecisionJson(input.row) }
  if (input.task === ReportVerificationTask.Coverage) {
    const source = input.input
    const result = verifyInferenceExpenseCoverage(
      source.evidence,
      source.accountId,
      source.frozen,
      source.authorityGenerationHash,
    )
    return Result.isSuccess(result)
      ? { id, outcome: 'COVERAGE', value: result.success }
      : {
          id,
          outcome: 'INVALID_INFERENCE',
          message:
            result.failure instanceof InferenceCostError
              ? result.failure.message
              : 'Inference expense coverage verification failed',
          cause: result.failure,
        }
  }
  const result = decodeInferenceCostRequest(input.input, input.asOf)
  return Result.isSuccess(result)
    ? { id, outcome: 'INFERENCE', value: result.success }
    : { id, outcome: 'INVALID_INFERENCE', message: result.failure.message, cause: result.failure }
}

if (parentPort !== null) {
  const port = parentPort
  const requests = Effect.gen(function* () {
    const queue = yield* Queue.bounded<ReportVerificationJob>(1)
    let decisionIndex: ReportDecisionIndex | undefined
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const receive = (job: ReportVerificationJob) => {
          if (!Queue.offerUnsafe(queue, job)) throw new Error('Report worker received more than one pending job')
        }
        port.on('message', receive)
        return receive
      }),
      (receive) =>
        Effect.sync(() => {
          port.off('message', receive)
        }),
    )
    return yield* Effect.forever(
      Queue.take(queue).pipe(
        Effect.flatMap((job) =>
          Effect.sync(() => {
            if (job.input.task === ReportVerificationTask.Decision && job.input.index !== undefined)
              decisionIndex = job.input.index
            return verifyReportJob(job, decisionIndex)
          }).pipe(
            Effect.catchDefect((cause) =>
              Effect.succeed<ReportVerificationReply>({ id: job.id, outcome: 'DEFECT', cause }),
            ),
            Effect.flatMap((reply) => Effect.sync(() => port.postMessage(reply))),
          ),
        ),
      ),
    )
  })
  NodeRuntime.runMain(Layer.effectDiscard(requests).pipe(Layer.provide(Logger.layer([])), Layer.launch))
}
