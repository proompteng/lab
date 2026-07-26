import { Cause, Effect, Schema } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import type { Intent } from '../../paper'
import { StrictNonEmptyStringSchema as NonEmptyString } from '../../schemas'
import { currentUtcInstant } from '../../time'
import { make as makeRead, paperTradingUrl } from '../alpaca'
import {
  classifyCancelResponse,
  classifySubmitResponse,
  prepareCancel,
  prepareSubmit,
  resolveMutationOptions,
} from './decisions'
import {
  BrokerMutationError,
  MutationOperation,
  configurationError,
  invalidRequest,
  unknownOutcome,
  type BrokerMutationShape,
  type MutationOptions,
} from './model'

const responseParseOptions = { onExcessProperty: 'ignore' } as const
const RequestId = NonEmptyString.check(Schema.isMaxLength(256))
const ResponseHeadersSchema = Schema.Struct({
  'x-request-id': RequestId,
})
const decodeHeaders = HttpClientResponse.schemaHeaders(ResponseHeadersSchema, responseParseOptions)

const redactedHeaders = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apca-api-key-id',
  'apca-api-secret-key',
] as const

const credentials = (key: string, secret: string) => ({
  'APCA-API-KEY-ID': key,
  'APCA-API-SECRET-KEY': secret,
})

const withDeadline = <A, E>(
  operation: MutationOperation,
  requestHash: string,
  timeoutMs: number,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, BrokerMutationError> =>
  effect.pipe(
    Effect.timeout(`${timeoutMs} millis`),
    Effect.mapError((cause) =>
      cause instanceof BrokerMutationError
        ? cause
        : unknownOutcome(
            operation,
            Cause.isTimeoutError(cause)
              ? `Alpaca ${operation.toLowerCase()} exceeded its ${timeoutMs}ms deadline`
              : `Alpaca ${operation.toLowerCase()} outcome is unknown because no valid response was available`,
            requestHash,
            undefined,
            cause,
          ),
    ),
  )

const responseHeaders = (
  operation: MutationOperation,
  requestHash: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<{ readonly 'x-request-id': string }, BrokerMutationError> =>
  decodeHeaders(response).pipe(
    Effect.mapError((cause) =>
      unknownOutcome(
        operation,
        `Alpaca ${operation.toLowerCase()} response headers are invalid`,
        requestHash,
        { status: response.status },
        cause,
      ),
    ),
  )

const readSubmitBody = (
  requestHash: string,
  response: HttpClientResponse.HttpClientResponse,
  headers: { readonly 'x-request-id': string },
): Effect.Effect<unknown, BrokerMutationError> =>
  response.json.pipe(
    Effect.mapError((cause) =>
      unknownOutcome(
        MutationOperation.Submit,
        'Alpaca submit response body is not valid JSON',
        requestHash,
        { status: response.status, requestId: headers['x-request-id'] },
        cause,
      ),
    ),
  )

const readCancelBody = (
  requestHash: string,
  response: HttpClientResponse.HttpClientResponse,
  headers: { readonly 'x-request-id': string },
): Effect.Effect<string | undefined, BrokerMutationError> =>
  response.status === 204
    ? Effect.succeed(undefined)
    : response.text.pipe(
        Effect.mapError((cause) =>
          unknownOutcome(
            MutationOperation.Cancel,
            'Alpaca cancel response body could not be read',
            requestHash,
            { status: response.status, requestId: headers['x-request-id'] },
            cause,
          ),
        ),
      )

export const makeMutation = (
  options: MutationOptions,
): Effect.Effect<BrokerMutationShape, BrokerMutationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.fromResult(resolveMutationOptions(options))
    const client = yield* HttpClient.HttpClient
    const read = yield* makeRead({
      expectedAccountId: runtime.expectedAccountId,
      key: options.key,
      secret: options.secret,
      proxyUrl: runtime.proxyUrl,
      operationTimeoutMs: runtime.operationTimeoutMs,
      retryAttempts: 0,
    }).pipe(
      Effect.mapError((cause) => configurationError('Alpaca mutation account verification could not start', cause)),
    )
    yield* read.account.pipe(
      Effect.mapError((cause) => configurationError('Alpaca mutation account verification failed', cause)),
    )

    const submit = Effect.fn('BrokerMutation.submit', {
      attributes: { 'broker.system': 'alpaca', 'broker.operation': MutationOperation.Submit },
    })(
      function* (input: Intent) {
        const prepared = yield* Effect.fromResult(prepareSubmit(input, runtime.expectedAccountId))
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(new URL('/v2/orders', paperTradingUrl), {
            acceptJson: true,
            headers: credentials(runtime.key, runtime.secret),
          }),
          prepared.request,
        ).pipe(
          Effect.mapError((cause) =>
            invalidRequest(MutationOperation.Submit, 'order request cannot be encoded', cause),
          ),
        )
        return yield* withDeadline(
          MutationOperation.Submit,
          prepared.requestHash,
          runtime.operationTimeoutMs,
          Effect.gen(function* () {
            const response = yield* client.execute(request)
            const headers = yield* responseHeaders(MutationOperation.Submit, prepared.requestHash, response)
            const body = yield* readSubmitBody(prepared.requestHash, response, headers)
            const observedAt = yield* currentUtcInstant
            return yield* Effect.fromResult(
              classifySubmitResponse({
                ...prepared,
                status: response.status,
                requestId: headers['x-request-id'],
                body,
                observedAt,
              }),
            )
          }),
        )
      },
      (effect) => effect.pipe(Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders)),
    )

    const cancel = Effect.fn('BrokerMutation.cancel', {
      attributes: { 'broker.system': 'alpaca', 'broker.operation': MutationOperation.Cancel },
    })(
      function* (input: string) {
        const prepared = yield* Effect.fromResult(prepareCancel(input))
        const request = HttpClientRequest.delete(
          new URL(`/v2/orders/${encodeURIComponent(prepared.brokerOrderId)}`, paperTradingUrl),
          { headers: credentials(runtime.key, runtime.secret) },
        )
        return yield* withDeadline(
          MutationOperation.Cancel,
          prepared.requestHash,
          runtime.operationTimeoutMs,
          Effect.gen(function* () {
            const response = yield* client.execute(request)
            const headers = yield* responseHeaders(MutationOperation.Cancel, prepared.requestHash, response)
            const body = yield* readCancelBody(prepared.requestHash, response, headers)
            const observedAt = yield* currentUtcInstant
            return yield* Effect.fromResult(
              classifyCancelResponse({
                ...prepared,
                status: response.status,
                requestId: headers['x-request-id'],
                body,
                observedAt,
              }),
            )
          }),
        )
      },
      (effect) => effect.pipe(Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders)),
    )

    return { submit, cancel }
  })
