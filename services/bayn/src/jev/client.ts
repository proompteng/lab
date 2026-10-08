import { Cause, Clock, Context, Data, Effect, Layer, Redacted, Result, Schema, Stream } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'

import { canonicalHashV1Result } from '../hash'
import { utcInstantFromEpochMillis } from '../time'
import { withObservedStage } from '../telemetry'
import {
  decodeJevResponse,
  jevEndpoint,
  prepareJevRequest,
  JevFailure,
  JevResponseSchema,
  type JevResponse,
} from './contract'

const failedResponseUsageSchema = Schema.Struct({
  model: JevResponseSchema.fields.model,
  usage: JevResponseSchema.fields.usage,
})
const maximumFailureBodyBytes = 8192

export class JevError extends Data.TaggedError('JevError')<{
  readonly failure: JevFailure
  readonly message: string
  readonly requestHash?: string
  readonly responseHash?: string
  readonly status?: number
  readonly rejectedResponse?: Redacted.Redacted<unknown>
  readonly cause?: Redacted.Redacted<unknown>
}> {}

export interface JevInference {
  readonly requestHash: string
  readonly responseHash: string
  readonly startedAt: string
  readonly completedAt: string
  readonly response: JevResponse
}

export class JevClient extends Context.Service<
  JevClient,
  { readonly evaluate: (request: unknown) => Effect.Effect<JevInference, JevError> }
>()('@proompteng/bayn/JevClient') {}

export const JevClientLive = (key: Redacted.Redacted<string>, timeoutMs: number) =>
  Layer.effect(
    JevClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 10_000 ||
        Redacted.value(key).length === 0
      ) {
        return yield* new JevError({
          failure: JevFailure.Request,
          message: 'Jev requires a key and a 1-10000ms timeout',
        })
      }
      const evaluate = (input: unknown): Effect.Effect<JevInference, JevError> =>
        Effect.gen(function* () {
          const prepared = yield* Effect.fromResult(prepareJevRequest(input)).pipe(
            Effect.mapError(
              (cause) =>
                new JevError({ failure: JevFailure.Request, message: cause.message, cause: Redacted.make(cause) }),
            ),
          )
          const { requestHash } = prepared
          const started = yield* Clock.currentTimeMillis
          let failureHttpStatus: number | undefined
          return yield* Effect.gen(function* () {
            const request = HttpClientRequest.post(jevEndpoint).pipe(
              HttpClientRequest.bearerToken(key),
              HttpClientRequest.bodyText(prepared.body, 'application/json'),
              HttpClientRequest.acceptJson,
            )
            const response = yield* http.execute(request)
            if (response.status !== 200) {
              failureHttpStatus = response.status
              // Retain only validated metering, never provider error text or echoed requests/credentials.
              // The hash binds this exact projection, not the original error body. No missing usage is invented.
              const rejected = yield* response.stream.pipe(
                Stream.runFoldEffect(
                  () => new Uint8Array(0),
                  (body, chunk) => {
                    if (body.byteLength + chunk.byteLength > maximumFailureBodyBytes)
                      return Effect.fail(
                        new JevError({ failure: JevFailure.Status, message: 'Jev failure body exceeds its limit' }),
                      )
                    const next = new Uint8Array(body.byteLength + chunk.byteLength)
                    next.set(body)
                    next.set(chunk, body.byteLength)
                    return Effect.succeed(next)
                  },
                ),
                Effect.flatMap((body) =>
                  Effect.try({
                    try: (): unknown => JSON.parse(new TextDecoder().decode(body)),
                    catch: (cause) =>
                      new JevError({
                        failure: JevFailure.Status,
                        message: 'Jev failure body is not JSON',
                        cause: Redacted.make(cause),
                      }),
                  }),
                ),
                Effect.flatMap(Schema.decodeUnknownEffect(failedResponseUsageSchema)),
                Effect.result,
              )
              const responseHash = Result.isSuccess(rejected) ? canonicalHashV1Result(rejected.success) : undefined
              return yield* new JevError({
                failure: JevFailure.Status,
                message: 'Jev evaluation returned an unsuccessful status',
                requestHash,
                status: response.status,
                ...(Result.isSuccess(rejected) && responseHash !== undefined && Result.isSuccess(responseHash)
                  ? { responseHash: responseHash.success, rejectedResponse: Redacted.make(rejected.success) }
                  : {}),
                ...(Result.isFailure(rejected) ? { cause: Redacted.make(rejected.failure) } : {}),
              })
            }
            const raw = yield* response.json
            const responseHashResult = canonicalHashV1Result(raw)
            const responseHash = Result.isSuccess(responseHashResult) ? responseHashResult.success : undefined
            const decoded = yield* Effect.fromResult(decodeJevResponse(prepared.request, raw)).pipe(
              Effect.mapError(
                (cause) =>
                  new JevError({
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
              return yield* new JevError({
                failure: JevFailure.Response,
                message: 'Jev response cannot be canonically hashed',
                requestHash,
                rejectedResponse: Redacted.make(raw),
                cause: Redacted.make(responseHashResult),
              })
            }
            const completed = yield* Clock.currentTimeMillis
            if (completed < started || completed - started >= timeoutMs) {
              return yield* new JevError({
                failure: JevFailure.Timeout,
                message: 'Jev response arrived outside its inference deadline',
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
              cause instanceof JevError
                ? cause
                : new JevError({
                    failure: Cause.isTimeoutError(cause) ? JevFailure.Timeout : JevFailure.Transport,
                    message: Cause.isTimeoutError(cause) ? 'Jev inference deadline elapsed' : 'Jev transport failed',
                    requestHash,
                    ...(failureHttpStatus === undefined ? {} : { status: failureHttpStatus }),
                    cause: Redacted.make(cause),
                  }),
            ),
            withObservedStage('bayn.jev.inference', { dependency: 'jev', operation: 'evaluate' }),
          )
        })
      return { evaluate }
    }),
  )
