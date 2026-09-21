import { Clock, Context, Effect, Redacted, Result } from 'effect'

import type { OperationalError } from '../errors'
import { utcInstantFromEpochMillis } from '../time'
import { JevClient, JevError } from './client'
import { JevFailure } from './contract'
import {
  decodeJevEvaluationReceipt,
  decodeJevEvaluationRequest,
  JevEvidenceError,
  JevOutcome,
  makeJevEvaluationReceipt,
  usableJevInference,
  type JevEvaluationReceipt,
  type JevEvaluationRequest,
} from './evidence'

export enum JevClaim {
  Acquired = 'ACQUIRED',
  Pending = 'PENDING',
  Recorded = 'RECORDED',
}

export type JevEvaluationClaim =
  | { readonly status: JevClaim.Acquired }
  | { readonly status: JevClaim.Pending }
  | { readonly status: JevClaim.Recorded; readonly receipt: JevEvaluationReceipt }

export class JevEvaluationStore extends Context.Service<
  JevEvaluationStore,
  {
    readonly begin: (request: JevEvaluationRequest) => Effect.Effect<JevEvaluationClaim, OperationalError>
    readonly record: (
      request: JevEvaluationRequest,
      receipt: JevEvaluationReceipt,
    ) => Effect.Effect<void, OperationalError>
  }
>()('@proompteng/bayn/JevEvaluationStore') {}

export const evaluateJevOnce = (input: unknown) =>
  Effect.gen(function* () {
    const request = yield* Effect.fromResult(decodeJevEvaluationRequest(input))
    const started = yield* Clock.currentTimeMillis
    if (started < Date.parse(request.observedAt) || started >= Date.parse(request.expiresAt)) {
      return yield* new JevEvidenceError({ message: 'Jev evaluation request is outside its validity window' })
    }
    const store = yield* JevEvaluationStore
    const claim = yield* store.begin(request)
    if (claim.status === JevClaim.Pending) {
      return yield* new JevEvidenceError({
        message: 'Jev evaluation was already claimed without a durable result; a second inference is forbidden',
      })
    }
    let receipt: JevEvaluationReceipt
    if (claim.status === JevClaim.Recorded) {
      receipt = yield* Effect.fromResult(decodeJevEvaluationReceipt(request, claim.receipt))
    } else {
      const now = yield* Clock.currentTimeMillis
      if (now >= Date.parse(request.expiresAt) || now < started) {
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
      receipt = yield* Effect.fromResult(
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
                  result.failure.rejectedResponse === undefined
                    ? null
                    : Redacted.value(result.failure.rejectedResponse),
              },
        }),
      )
      yield* store.record(request, receipt)
    }
    const inference = yield* Effect.fromResult(usableJevInference(request, receipt, yield* Clock.currentTimeMillis))
    return { request, receipt, inference }
  })
