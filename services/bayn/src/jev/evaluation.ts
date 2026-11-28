import { Clock, Context, Effect, Result } from 'effect'

import type { OperationalError } from '../errors'
import { utcInstantFromEpochMillis } from '../time'
import { prepareClaimedEntry } from './entry-inference'
import {
  decodeJevEvaluationRequest,
  JevEvidenceError,
  type JevEvaluationReceipt,
  type JevEvaluationRequest,
} from './evidence'
import { type JevEvaluationEvidence, type JevResolution } from './resolution'

export type JevEvaluationRecord = { readonly request: JevEvaluationRequest; readonly receipt: JevEvaluationReceipt }

export class JevEvaluationStore extends Context.Service<
  JevEvaluationStore,
  {
    readonly read: (requestId: string) => Effect.Effect<JevEvaluationEvidence | null, OperationalError>
    readonly recordAll: (
      entries: readonly JevEvaluationRecord[],
    ) => Effect.Effect<ReadonlyMap<string, JevResolution>, OperationalError>
    readonly abandon: (
      request: JevEvaluationRequest,
      abandonedAt: string,
    ) => Effect.Effect<JevResolution, OperationalError>
  }
>()('@proompteng/bayn/JevEvaluationStore') {}

export const makeJevDispatch = (input: { readonly request: JevEvaluationRequest; readonly claimedAt: string }) =>
  Result.gen(function* () {
    const { request, claimedAt } = input
    const entry = yield* prepareClaimedEntry({
      requestId: request.requestId,
      input: request.request,
      observedAt: request.observedAt,
      expiresAt: request.expiresAt,
      claimedAt,
    })
    const detachedInput = entry.prepared.input
    const visualClaim = entry.visualClaim === null ? null : Object.freeze(entry.visualClaim)
    // Only the single-use dispatch can release the detached request and its verified chart.
    const prepared = {
      ...entry,
      claim: { ...entry.claim, input: detachedInput },
      request: { ...request, request: detachedInput },
    }
    let consumed = false
    return Object.freeze({
      request,
      claimedAt,
      visualClaim,
      consume: Effect.suspend(() => {
        if (consumed)
          return Effect.fail(
            new JevEvidenceError({ message: 'An admitted provider dispatch cannot be consumed twice' }),
          )
        consumed = true
        return Effect.succeed(prepared)
      }),
    })
  })

export type JevDispatch = Result.Result.Success<ReturnType<typeof makeJevDispatch>>

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
