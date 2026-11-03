import { Clock, Context, Effect } from 'effect'

import type { OperationalError } from '../errors'
import { utcInstantFromEpochMillis } from '../time'
import type { StagedDispatchClaim } from './staged-checkpoint'
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

export interface JevDispatch {
  readonly request: JevEvaluationRequest
  readonly claimedAt: string
  readonly visualClaim: StagedDispatchClaim | null
  readonly consume: Effect.Effect<void, JevEvidenceError>
}

export const makeJevDispatch = (input: Omit<JevDispatch, 'consume'>): JevDispatch => {
  let consumed = false
  return {
    ...input,
    consume: Effect.suspend(() => {
      if (consumed)
        return Effect.fail(new JevEvidenceError({ message: 'An admitted provider dispatch cannot be consumed twice' }))
      consumed = true
      return Effect.void
    }),
  }
}

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
