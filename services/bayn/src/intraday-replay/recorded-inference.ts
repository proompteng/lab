import { Clock, Effect, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1Result } from '../hash'
import { JevError } from '../jev/client'
import { decodeJevResponse, JevFailure, prepareJevRequest } from '../jev/contract'
import { DecisionsError, decodeDecisionsResponse, prepareDecisionsRequest } from '../jev/decisions'
import { GitSourceRevisionSchema, Sha256Schema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import { ReplayBrokerFailure } from './broker'
import {
  ReplayInferenceCallSchema,
  replayVisualStage,
  type ReplayInferenceCall,
  type ReplayInferenceProviders,
} from './inference-timing'

export const ReplayInferenceRecordingSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.replay-inference-recording.v1'),
  sourceManifestHash: Sha256Schema,
  sourceRevision: GitSourceRevisionSchema,
  strategyBehaviorHash: Sha256Schema,
  strategyParameterHash: Sha256Schema,
  jevInstructionsHash: Sha256Schema,
  calls: Schema.Array(ReplayInferenceCallSchema),
})

export const validateReplayInferenceCalls = (calls: readonly ReplayInferenceCall[]) =>
  Result.gen(function* () {
    const identities = new Set<string>()
    for (const call of calls) {
      const prepared =
        call.stage === 'JEV' ? yield* prepareJevRequest(call.request) : yield* prepareDecisionsRequest(call.request)
      const identity = `${call.stage}:${call.requestHash}:${call.simulatedStartedAt}`
      if (
        prepared.requestHash !== call.requestHash ||
        call.providerCompletedAt < call.providerStartedAt ||
        identities.has(identity)
      )
        return yield* Result.fail(
          new ReplayBrokerFailure({ message: 'Retained inference request, clock or occurrence is invalid' }),
        )
      identities.add(identity)
      if (call.stage !== 'JEV' && call.stage !== replayVisualStage(call.request))
        return yield* Result.fail(
          new ReplayBrokerFailure({ message: 'Retained visual stage differs from its request' }),
        )
      if (call.outcome.status === 'RECEIVED') {
        const inference = call.outcome.inference
        if (
          inference.requestHash !== call.requestHash ||
          (yield* canonicalHashV1Result(inference.response)) !== inference.responseHash ||
          inference.startedAt < call.providerStartedAt ||
          inference.completedAt < inference.startedAt ||
          inference.completedAt > call.providerCompletedAt
        )
          return yield* Result.fail(
            new ReplayBrokerFailure({ message: 'Retained inference response evidence differs' }),
          )
        if (call.stage === 'JEV') yield* decodeJevResponse(call.request, call.outcome.inference.response)
        else yield* decodeDecisionsResponse(call.request, call.outcome.inference.response)
      } else if (
        call.stage === 'JEV' &&
        call.outcome.status === 'FAILED' &&
        call.outcome.responseHash !== null &&
        (yield* canonicalHashV1Result(call.outcome.rejectedResponse)) !== call.outcome.responseHash
      )
        return yield* Result.fail(new ReplayBrokerFailure({ message: 'Retained rejected response digest differs' }))
    }
    return calls
  })

export const validateReplayInferenceRecording = (raw: unknown, expectedHash: string) =>
  Result.gen(function* () {
    const recording = yield* Schema.decodeUnknownResult(ReplayInferenceRecordingSchema, strictParseOptions)(raw)
    if ((yield* canonicalHashV1Result(recording)) !== expectedHash)
      return yield* Result.fail(new ReplayBrokerFailure({ message: 'Retained inference recording digest differs' }))
    yield* validateReplayInferenceCalls(recording.calls)
    return recording
  }).pipe(
    Result.mapError((cause) => new ReplayBrokerFailure({ message: 'Invalid retained inference recording', cause })),
  )

/** A complete replay may consume a causal subset, but cannot substitute responses or reuse occurrences. */
export const validateRetainedReplayCalls = (
  recording: typeof ReplayInferenceRecordingSchema.Type,
  calls: readonly ReplayInferenceCall[],
) =>
  Result.gen(function* () {
    yield* validateReplayInferenceCalls(calls)
    const pending = new Map<string, ReplayInferenceCall[]>()
    for (const call of [...recording.calls].sort((a, b) => a.simulatedStartedAt.localeCompare(b.simulatedStartedAt))) {
      const key = `${call.stage}:${call.requestHash}`
      const occurrences = pending.get(key) ?? []
      occurrences.push(call)
      pending.set(key, occurrences)
    }
    const outcome = (call: ReplayInferenceCall) => {
      if (call.outcome.status !== 'RECEIVED') return call.outcome
      const { startedAt: _started, completedAt: _completed, ...inference } = call.outcome.inference
      return { status: call.outcome.status, inference }
    }
    for (const call of [...calls].sort((a, b) => a.simulatedStartedAt.localeCompare(b.simulatedStartedAt))) {
      const retained = pending.get(`${call.stage}:${call.requestHash}`)?.shift()
      if (
        retained === undefined ||
        retained.simulatedStartedAt > call.simulatedStartedAt ||
        Date.parse(call.providerCompletedAt) - Date.parse(call.providerStartedAt) <
          Date.parse(retained.providerCompletedAt) - Date.parse(retained.providerStartedAt) ||
        (yield* canonicalHashV1Result(outcome(call))) !== (yield* canonicalHashV1Result(outcome(retained)))
      )
        return yield* Result.fail(
          new ReplayBrokerFailure({
            message: 'Complete replay changed a retained inference occurrence or its duration',
          }),
        )
    }
    return calls
  })

/** Exact request occurrences are consumed once. A changed counterfactual request requires new evidence. */
export const makeRecordedInferenceProviders = (
  recording: typeof ReplayInferenceRecordingSchema.Type,
  marketClock: Clock.Clock,
) =>
  Effect.sync(() => {
    const pending = new Map<string, ReplayInferenceCall[]>()
    for (const call of [...recording.calls].sort((a, b) => a.simulatedStartedAt.localeCompare(b.simulatedStartedAt))) {
      const key = `${call.stage}:${call.requestHash}`
      const occurrences = pending.get(key) ?? []
      occurrences.push(call)
      pending.set(key, occurrences)
    }
    let consumed = 0
    let unsupported: ReplayBrokerFailure | undefined
    const claim = (stage: ReplayInferenceCall['stage'], requestHash: string, at: number) => {
      const occurrences = pending.get(`${stage}:${requestHash}`)
      const call = occurrences?.[0]
      if (occurrences === undefined || call === undefined || Date.parse(call.simulatedStartedAt) > at) {
        unsupported ??= new ReplayBrokerFailure({
          message: 'Replay request has no unused causal retained inference occurrence',
        })
        return undefined
      }
      occurrences.shift()
      consumed++
      return call
    }
    const delay = (call: ReplayInferenceCall) =>
      Effect.sleep(Date.parse(call.providerCompletedAt) - Date.parse(call.providerStartedAt))
    const providers: ReplayInferenceProviders = {
      jev: {
        evaluate: (raw, budgetMs) =>
          Effect.gen(function* () {
            const prepared = yield* Effect.fromResult(prepareJevRequest(raw)).pipe(
              Effect.mapError(
                (cause) =>
                  new JevError({ failure: JevFailure.Request, message: cause.message, cause: Redacted.make(cause) }),
              ),
            )
            if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 10_000)
              return yield* new JevError({
                failure: JevFailure.Request,
                message: 'Invalid retained inference deadline',
              })
            const call = claim('JEV', prepared.requestHash, yield* marketClock.currentTimeMillis)
            if (call === undefined || call.stage !== 'JEV')
              return yield* new JevError({
                failure: JevFailure.Request,
                message: 'Retained Jev inference is unavailable',
              })
            const startedAt = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
            yield* delay(call).pipe(
              Effect.timeoutOrElse({
                duration: budgetMs,
                orElse: () =>
                  Effect.fail(
                    new JevError({
                      failure: JevFailure.Timeout,
                      message: 'Retained inference exceeded its remaining deadline',
                    }),
                  ),
              }),
            )
            const outcome = call.outcome
            switch (outcome.status) {
              case 'RECEIVED':
                return {
                  ...outcome.inference,
                  startedAt,
                  completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                }
              case 'FAILED':
                return yield* new JevError({
                  failure: outcome.failure,
                  message: 'Retained Jev provider failure',
                  requestHash: call.requestHash,
                  ...(outcome.httpStatus === null ? {} : { status: outcome.httpStatus }),
                  ...(outcome.responseHash === null
                    ? {}
                    : {
                        responseHash: outcome.responseHash,
                        rejectedResponse: Redacted.make(outcome.rejectedResponse),
                      }),
                })
              case 'INTERRUPTED':
                return yield* Effect.interrupt
              case 'DEFECT':
                return yield* Effect.die(new ReplayBrokerFailure({ message: 'Retained Jev provider defect' }))
            }
          }),
      },
      chart: {
        evaluate: (raw, budgetMs) =>
          Effect.gen(function* () {
            const prepared = yield* Effect.fromResult(prepareDecisionsRequest(raw))
            if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 10_000)
              return yield* new DecisionsError({ category: 'REQUEST', message: 'Invalid retained inference deadline' })
            const stage = replayVisualStage(prepared.request)
            const call = claim(stage, prepared.requestHash, yield* marketClock.currentTimeMillis)
            if (call === undefined || call.stage !== stage)
              return yield* new DecisionsError({
                category: 'REQUEST',
                message: 'Retained chart inference is unavailable',
              })
            const startedAt = utcInstantFromEpochMillis(yield* Clock.currentTimeMillis)
            yield* delay(call).pipe(
              Effect.timeoutOrElse({
                duration: budgetMs,
                orElse: () =>
                  Effect.fail(
                    new DecisionsError({
                      category: 'DEADLINE',
                      message: 'Retained inference exceeded its remaining deadline',
                    }),
                  ),
              }),
            )
            const outcome = call.outcome
            switch (outcome.status) {
              case 'RECEIVED':
                return {
                  ...outcome.inference,
                  startedAt,
                  completedAt: utcInstantFromEpochMillis(yield* Clock.currentTimeMillis),
                }
              case 'FAILED':
                return yield* new DecisionsError({
                  category: outcome.category,
                  message: 'Retained chart provider failure',
                  requestHash: call.requestHash,
                  ...(outcome.httpStatus === null ? {} : { status: outcome.httpStatus }),
                  ...(outcome.responseHash === null ? {} : { responseHash: outcome.responseHash }),
                  ...(outcome.usage === null ? {} : { usage: outcome.usage }),
                })
              case 'INTERRUPTED':
                return yield* Effect.interrupt
              case 'DEFECT':
                return yield* Effect.die(new ReplayBrokerFailure({ message: 'Retained chart provider defect' }))
            }
          }),
      },
    }
    return {
      providers,
      consumedCount: () => consumed,
      assertSupported: Effect.suspend(() => (unsupported === undefined ? Effect.void : Effect.fail(unsupported))),
    }
  })
