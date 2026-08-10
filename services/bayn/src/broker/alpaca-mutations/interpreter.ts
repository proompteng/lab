import { Cause, Effect } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import type { ExecutionAuthority } from '../../execution/authority'
import type { Intent } from '../../paper'
import { currentUtcInstant } from '../../time'
import type { BrokerSessionShape } from '../alpaca'
import { ResponseHeadersSchema, redactedHeaders, responseParseOptions } from '../alpaca/model'
import { cancelOrderUrl, submitOrderUrl } from '../alpaca/requests'
import {
  classifyCancelResponse,
  classifySubmitResponse,
  prepareCancel,
  prepareSubmit,
  resolveMutationCapability,
} from './decisions'
import {
  BrokerMutationError,
  MutationOperation,
  invalidRequest,
  unknownOutcome,
  type BrokerMutationShape,
} from './model'

const decodeHeaders = HttpClientResponse.schemaHeaders(ResponseHeadersSchema, responseParseOptions)

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
    ? Effect.as(Effect.void, undefined)
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
  session: BrokerSessionShape,
  authority: ExecutionAuthority,
  client: HttpClient.HttpClient,
): Effect.Effect<BrokerMutationShape, BrokerMutationError> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.fromResult(resolveMutationCapability(session, authority))

    const submit = Effect.fn('BrokerMutation.submit', {
      attributes: { 'broker.system': 'alpaca', 'broker.operation': MutationOperation.Submit },
    })(
      function* (input: Intent) {
        const prepared = yield* Effect.fromResult(prepareSubmit(input, runtime.expectedAccountId))
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(submitOrderUrl(runtime.connection), {
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
        const request = HttpClientRequest.delete(cancelOrderUrl(runtime.connection, prepared.brokerOrderId), {
          headers: credentials(runtime.key, runtime.secret),
        })
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
                ...(body === undefined ? {} : { body }),
                observedAt,
              }),
            )
          }),
        )
      },
      (effect) => effect.pipe(Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders)),
    )

    return {
      submit,
      cancel,
      orderById: session.read.orderById,
      orderByClientId: session.read.orderByClientId,
    }
  })
