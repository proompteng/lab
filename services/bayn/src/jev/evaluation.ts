import { Clock, Context, Effect, Redacted, Result } from 'effect'

import type { OperationalError } from '../errors'
import { utcInstantFromEpochMillis } from '../time'
import { JevClient, JevError } from './client'
import { JevFailure } from './contract'
import {
  decodeJevEvaluationRequest,
  JevEvidenceError,
  JevOutcome,
  makeJevEvaluationReceipt,
  usableJevInference,
  type JevEvaluationReceipt,
  type JevEvaluationRequest,
} from './evidence'
import { decodeJevResolution, JevResolutionStatus, type JevEvaluationEvidence, type JevResolution } from './resolution'

export class JevEvaluationStore extends Context.Service<
  JevEvaluationStore,
  {
    readonly read: (requestId: string) => Effect.Effect<JevEvaluationEvidence | null, OperationalError>
    readonly record: (
      request: JevEvaluationRequest,
      receipt: JevEvaluationReceipt,
    ) => Effect.Effect<JevResolution, OperationalError>
    readonly abandon: (
      request: JevEvaluationRequest,
      abandonedAt: string,
    ) => Effect.Effect<JevResolution, OperationalError>
  }
>()('@proompteng/bayn/JevEvaluationStore') {}

export interface JevDispatch {
  readonly request: JevEvaluationRequest
  readonly claimedAt: string
}

export const evaluateClaimedJevOnce = (dispatch: JevDispatch) =>
  Effect.gen(function* () {
    const request = yield* Effect.fromResult(decodeJevEvaluationRequest(dispatch.request))
    const started = Date.parse(dispatch.claimedAt)
    if (
      !Number.isFinite(started) ||
      started < Date.parse(request.observedAt) ||
      started >= Date.parse(request.expiresAt)
    )
      return yield* new JevEvidenceError({ message: 'Jev dispatch claim is outside its validity window' })
    const store = yield* JevEvaluationStore
    const now = yield* Clock.currentTimeMillis
    if (now >= Date.parse(request.expiresAt) || now < started) {
      if (now >= Date.parse(request.expiresAt)) {
        const notDispatched = yield* Effect.fromResult(
          makeJevEvaluationReceipt(request, {
            schemaVersion: 'bayn.jev-evaluation-receipt.v1',
            requestId: request.requestId,
            startedAt: utcInstantFromEpochMillis(started),
            completedAt: utcInstantFromEpochMillis(now),
            outcome: {
              status: JevOutcome.Failed,
              failure: JevFailure.NotDispatched,
              httpStatus: null,
              responseHash: null,
              rejectedResponse: null,
            },
          }),
        )
        yield* store.record(request, notDispatched)
      }
      return yield* new JevEvidenceError({ message: 'Jev request expired or its clock regressed during persistence' })
    }
    const client = yield* JevClient
    const result = yield* client.evaluate(request.request).pipe(
      Effect.timeoutOrElse({
        duration: Date.parse(request.expiresAt) - now,
        orElse: () =>
          Effect.fail(
            new JevError({
              failure: JevFailure.Timeout,
              message: 'Jev request validity expired during inference',
              requestHash: request.requestHash,
            }),
          ),
      }),
      Effect.result,
    )
    const completedAt = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
    const receipt = yield* Effect.fromResult(
      makeJevEvaluationReceipt(request, {
        schemaVersion: 'bayn.jev-evaluation-receipt.v1',
        requestId: request.requestId,
        startedAt: utcInstantFromEpochMillis(started),
        completedAt,
        outcome: Result.isSuccess(result)
          ? { status: JevOutcome.Received, inference: result.success }
          : {
              status: JevOutcome.Failed,
              failure: result.failure.failure,
              httpStatus: result.failure.status ?? null,
              responseHash: result.failure.responseHash ?? null,
              rejectedResponse:
                result.failure.rejectedResponse === undefined ? null : Redacted.value(result.failure.rejectedResponse),
            },
      }),
    )
    const resolution = yield* Effect.fromResult(
      decodeJevResolution(request, receipt, yield* store.record(request, receipt)),
    )
    if (resolution.status !== JevResolutionStatus.Recorded)
      return yield* new JevEvidenceError({
        message: 'Jev evidence arrived after permanent abandonment; entry is forbidden',
      })
    const inference = yield* Effect.fromResult(usableJevInference(request, receipt, yield* Clock.currentTimeMillis))
    return { request, receipt, resolution, inference }
  })

export const recoverExpiredJevEvaluation = (input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
    const now = yield* Clock.currentTimeMillis
    if (now < Date.parse(request.expiresAt))
      return yield* new JevEvidenceError({ message: 'An unexpired Jev evaluation cannot be abandoned' })
    const store = yield* JevEvaluationStore
    const resolution = yield* store.abandon(request, utcInstantFromEpochMillis(now))
    return { request, resolution }
  })
