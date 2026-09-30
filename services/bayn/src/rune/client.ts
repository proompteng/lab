import { Cause, Clock, Context, Data, Effect, Layer, Redacted, Result } from 'effect'
import { Headers, HttpClient, HttpClientRequest } from 'effect/unstable/http'

import { canonicalHashV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import { JevFailure } from '../jev/contract'
import { decodeRuneResponse, runeEndpoint, prepareRuneRequest, type RuneResponse } from './contract'

export class RuneError extends Data.TaggedError('RuneError')<{
  readonly failure: JevFailure
  readonly message: string
  readonly requestHash?: string
  readonly responseHash?: string
  readonly status?: number
  readonly rejectedResponse?: Redacted.Redacted<unknown>
  readonly cause?: Redacted.Redacted<unknown>
}> {}

export interface RuneInference {
  readonly requestHash: string
  readonly responseHash: string
  readonly startedAt: string
  readonly completedAt: string
  readonly response: RuneResponse
}

export class RuneClient extends Context.Service<
  RuneClient,
  { readonly evaluate: (request: unknown) => Effect.Effect<RuneInference, RuneError> }
>()('@proompteng/bayn/RuneClient') {}

export const RuneClientLive = (timeoutMs: number) =>
  Layer.effect(
    RuneClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 10_000) {
        return yield* new RuneError({
          failure: JevFailure.Request,
          message: 'Rune requires a 1-10000ms timeout',
        })
      }
      const evaluate = (input: unknown): Effect.Effect<RuneInference, RuneError> =>
        Effect.gen(function* () {
          const prepared = yield* Effect.fromResult(prepareRuneRequest(input)).pipe(
            Effect.mapError(
              (cause) =>
                new RuneError({ failure: JevFailure.Request, message: cause.message, cause: Redacted.make(cause) }),
            ),
          )
          const { requestHash } = prepared
          const started = yield* Clock.currentTimeMillis
          return yield* Effect.gen(function* () {
            const request = HttpClientRequest.post(runeEndpoint).pipe(
              HttpClientRequest.bodyText(prepared.body, 'application/json'),
              HttpClientRequest.acceptJson,
            )
            const response = yield* http.execute(request)
            if (response.status !== 200) {
              return yield* new RuneError({
                failure: JevFailure.Status,
                message: 'Rune evaluation returned an unsuccessful status',
                requestHash,
                status: response.status,
              })
            }
            const raw = yield* response.json
            const responseHashResult = canonicalHashV1Result(raw)
            const responseHash = Result.isSuccess(responseHashResult) ? responseHashResult.success : undefined
            const decoded = yield* Effect.fromResult(decodeRuneResponse(prepared.request, raw)).pipe(
              Effect.mapError(
                (cause) =>
                  new RuneError({
                    failure: JevFailure.Response,
                    message: cause.message,
                    requestHash,
                    ...(responseHash === undefined ? {} : { responseHash }),
                    rejectedResponse: Redacted.make(raw),
                    cause: Redacted.make(cause),
                  }),
              ),
            )
            if (responseHash === undefined) {
              return yield* new RuneError({
                failure: JevFailure.Response,
                message: 'Rune response cannot be canonically hashed',
                requestHash,
                rejectedResponse: Redacted.make(raw),
                cause: Redacted.make(responseHashResult),
              })
            }
            const completed = yield* Clock.currentTimeMillis
            if (completed < started || completed - started >= timeoutMs) {
              return yield* new RuneError({
                failure: JevFailure.Timeout,
                message: 'Rune response arrived outside its inference deadline',
                requestHash,
                responseHash,
                rejectedResponse: Redacted.make(raw),
              })
            }
            return {
              requestHash,
              responseHash,
              startedAt: utcInstantFromEpochMillis(started),
              completedAt: utcInstantFromEpochMillis(completed),
              response: decoded,
            }
          }).pipe(
            Effect.timeout(`${timeoutMs} millis`),
            Effect.mapError((cause) =>
              cause instanceof RuneError
                ? cause
                : new RuneError({
                    failure: Cause.isTimeoutError(cause) ? JevFailure.Timeout : JevFailure.Transport,
                    message: Cause.isTimeoutError(cause) ? 'Rune inference deadline elapsed' : 'Rune transport failed',
                    requestHash,
                    cause: Redacted.make(cause),
                  }),
            ),
            Effect.provideService(Headers.CurrentRedactedNames, ['authorization']),
          )
        })
      return { evaluate }
    }),
  )
