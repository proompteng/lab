import { Cause, Clock, Context, Data, Effect, Redacted, Schema } from 'effect'
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http'

import { canonicalHashV1 } from '../hash'
import {
  IntentSchema,
  IntentState,
  MutationOutcome,
  OrderSide as DomainSide,
  OrderType as DomainOrderType,
  TimeInForce as DomainTimeInForce,
  type Intent,
} from '../paper'
import { StrictNonEmptyStringSchema as NonEmptyString, UtcInstantSchema as UtcInstant } from '../schemas'
import {
  OrderResponseSchema,
  OrderSide,
  OrderType,
  TimeInForce,
  make as makeRead,
  normalizeOrder,
  paperTradingUrl,
  type Order,
} from './alpaca'

const responseParseOptions = { onExcessProperty: 'ignore' } as const
const inputParseOptions = { onExcessProperty: 'error' } as const
const redactedHeaders = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apca-api-key-id',
  'apca-api-secret-key',
] as const

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const RequestId = NonEmptyString.check(Schema.isMaxLength(256))
const ErrorCode = Schema.Union([NonEmptyString.check(Schema.isMaxLength(64)), Schema.Int])
const ErrorMessage = NonEmptyString.check(Schema.isMaxLength(1_000))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))

const ResponseHeadersSchema = Schema.Struct({
  'x-request-id': RequestId,
})
const ErrorResponseSchema = Schema.Struct({
  code: ErrorCode,
  message: ErrorMessage,
})
const OptionsSchema = Schema.Struct({
  expectedAccountId: Uuid,
  operationTimeoutMs: PositiveInteger,
})

const decodeHeaders = HttpClientResponse.schemaHeaders(ResponseHeadersSchema, responseParseOptions)
const decodeErrorResponse = Schema.decodeUnknownEffect(ErrorResponseSchema, responseParseOptions)
const decodeOrderResponse = Schema.decodeUnknownEffect(OrderResponseSchema, responseParseOptions)
const decodeIntent = Schema.decodeUnknownEffect(IntentSchema, inputParseOptions)
const decodeOptions = Schema.decodeUnknownEffect(OptionsSchema, inputParseOptions)

export enum MutationOperation {
  Submit = 'SUBMIT',
  Cancel = 'CANCEL',
}

export enum MutationFailure {
  Configuration = 'CONFIGURATION',
  InvalidRequest = 'INVALID_REQUEST',
  Rejected = 'REJECTED',
  Unknown = 'UNKNOWN',
}

export const MutationEvidenceSchema = Schema.Struct({
  requestId: RequestId,
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  contentHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
  observedAt: UtcInstant,
})
export type MutationEvidence = typeof MutationEvidenceSchema.Type

export class BrokerMutationError extends Data.TaggedError('BrokerMutationError')<{
  readonly operation: MutationOperation
  readonly failure: MutationFailure
  readonly outcome: MutationOutcome
  readonly message: string
  readonly requestHash?: string
  readonly evidence?: Partial<MutationEvidence>
  readonly brokerOrderId?: string
  readonly brokerCode?: string
  readonly cause?: Readonly<Record<string, string>>
}> {}

export interface MutationOptions {
  readonly expectedAccountId: string
  readonly key: Redacted.Redacted<string>
  readonly secret: Redacted.Redacted<string>
  readonly proxyUrl: string
  readonly operationTimeoutMs: number
}

interface SubmitReceipt {
  readonly requestHash: string
  readonly order: Order
  readonly evidence: MutationEvidence
}

interface CancelReceipt {
  readonly requestHash: string
  readonly brokerOrderId: string
  readonly evidence: MutationEvidence
}

export interface BrokerMutationShape {
  readonly submit: (intent: Intent) => Effect.Effect<SubmitReceipt, BrokerMutationError>
  readonly cancel: (brokerOrderId: string) => Effect.Effect<CancelReceipt, BrokerMutationError>
}

export class BrokerMutation extends Context.Service<BrokerMutation, BrokerMutationShape>()('bayn/BrokerMutation') {}

const causeSummary = (cause: unknown): Readonly<Record<string, string>> => {
  if (Schema.isSchemaError(cause)) return { tag: cause._tag, message: cause.message }
  if (typeof cause === 'object' && cause !== null && '_tag' in cause && typeof cause._tag === 'string') {
    const reason =
      'reason' in cause && typeof cause.reason === 'object' && cause.reason !== null && '_tag' in cause.reason
        ? String(cause.reason._tag)
        : undefined
    return { tag: cause._tag, ...(reason === undefined ? {} : { reason }) }
  }
  if (cause instanceof Error) return { tag: cause.name }
  return { tag: typeof cause }
}

const configurationError = (message: string, cause?: unknown) =>
  new BrokerMutationError({
    operation: MutationOperation.Submit,
    failure: MutationFailure.Configuration,
    outcome: MutationOutcome.Known,
    message,
    cause: cause === undefined ? undefined : causeSummary(cause),
  })

const invalidRequest = (operation: MutationOperation, message: string, cause?: unknown) =>
  new BrokerMutationError({
    operation,
    failure: MutationFailure.InvalidRequest,
    outcome: MutationOutcome.Known,
    message,
    cause: cause === undefined ? undefined : causeSummary(cause),
  })

const unknownOutcome = (
  operation: MutationOperation,
  message: string,
  requestHash?: string,
  evidence?: Partial<MutationEvidence>,
  cause?: unknown,
) =>
  new BrokerMutationError({
    operation,
    failure: MutationFailure.Unknown,
    outcome: MutationOutcome.Unknown,
    message,
    requestHash,
    evidence,
    cause: cause === undefined ? undefined : causeSummary(cause),
  })

const knownRejection = (requestHash: string, evidence: MutationEvidence, code: string | number, message: string) =>
  new BrokerMutationError({
    operation: MutationOperation.Submit,
    failure: MutationFailure.Rejected,
    outcome: MutationOutcome.Known,
    message: `Alpaca rejected the order (${String(code)}): ${message}`,
    requestHash,
    evidence,
    brokerCode: String(code),
  })

const mismatchedAcceptedOrder = (requestHash: string, evidence: MutationEvidence, brokerOrderId: string) =>
  new BrokerMutationError({
    operation: MutationOperation.Submit,
    failure: MutationFailure.Unknown,
    outcome: MutationOutcome.Unknown,
    message: 'Alpaca accepted an order that does not match the durable intent',
    requestHash,
    evidence,
    brokerOrderId,
  })

const microsToDecimal = (value: string): string => {
  const micros = BigInt(value)
  const whole = micros / 1_000_000n
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`
}

const side = (value: DomainSide): OrderSide => {
  switch (value) {
    case DomainSide.Buy:
      return OrderSide.Buy
    case DomainSide.Sell:
      return OrderSide.Sell
  }
}

const timeInForce = (value: DomainTimeInForce): TimeInForce => {
  switch (value) {
    case DomainTimeInForce.Day:
      return TimeInForce.Day
    case DomainTimeInForce.GoodUntilCanceled:
      return TimeInForce.GoodUntilCanceled
    case DomainTimeInForce.ImmediateOrCancel:
      return TimeInForce.ImmediateOrCancel
    case DomainTimeInForce.FillOrKill:
      return TimeInForce.FillOrKill
  }
}

export const orderRequestBody = (intent: Intent) => {
  if (intent.orderType !== DomainOrderType.Market) throw new Error('Bayn broker submission supports market orders only')
  if (intent.timeInForce !== DomainTimeInForce.Day && BigInt(intent.quantityMicros) % 1_000_000n !== 0n) {
    throw new Error('fractional market orders require DAY time in force')
  }
  return {
    symbol: intent.symbol,
    qty: microsToDecimal(intent.quantityMicros),
    side: side(intent.side),
    type: OrderType.Market,
    time_in_force: timeInForce(intent.timeInForce),
    client_order_id: intent.clientOrderId,
    extended_hours: false,
  } as const
}

export const submitBody = (intent: Intent) => {
  if (intent.state !== IntentState.IoStarted) throw new Error('intent must be IO_STARTED before broker submission')
  return orderRequestBody(intent)
}

export const cancelRequestHash = (brokerOrderId: string): string =>
  canonicalHashV1({ operation: MutationOperation.Cancel, brokerOrderId })

const credentials = (key: string, secret: string) => ({
  'APCA-API-KEY-ID': key,
  'APCA-API-SECRET-KEY': secret,
})

const responseEvidence = (
  requestId: string,
  status: number,
  contentHash: string,
  observedAt: string,
): MutationEvidence => ({ requestId, status, contentHash, observedAt })

const withDeadline = <A>(
  operation: MutationOperation,
  requestHash: string,
  timeoutMs: number,
  effect: Effect.Effect<A, unknown>,
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

export const makeMutation = (
  options: MutationOptions,
): Effect.Effect<BrokerMutationShape, BrokerMutationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const runtime = yield* decodeOptions({
      expectedAccountId: options.expectedAccountId,
      operationTimeoutMs: options.operationTimeoutMs,
    }).pipe(Effect.mapError((cause) => configurationError('invalid Alpaca mutation options', cause)))
    const key = Redacted.value(options.key)
    const secret = Redacted.value(options.secret)
    if (key.length === 0 || key.trim() !== key || secret.length === 0 || secret.trim() !== secret) {
      return yield* Effect.fail(
        configurationError('Alpaca credentials must be non-empty without surrounding whitespace'),
      )
    }
    const client = yield* HttpClient.HttpClient
    const read = yield* makeRead({
      expectedAccountId: runtime.expectedAccountId,
      key: options.key,
      secret: options.secret,
      proxyUrl: options.proxyUrl,
      operationTimeoutMs: runtime.operationTimeoutMs,
      retryAttempts: 0,
    }).pipe(
      Effect.mapError((cause) => configurationError('Alpaca mutation account verification could not start', cause)),
    )
    yield* read.account.pipe(
      Effect.mapError((cause) => configurationError('Alpaca mutation account verification failed', cause)),
    )

    const submit = (input: Intent) =>
      Effect.gen(function* () {
        const intent = yield* decodeIntent(input).pipe(
          Effect.mapError((cause) => invalidRequest(MutationOperation.Submit, 'invalid order intent', cause)),
        )
        const body = yield* Effect.try({
          try: () => submitBody(intent),
          catch: (cause) => invalidRequest(MutationOperation.Submit, 'order intent cannot be submitted', cause),
        })
        const requestHash = canonicalHashV1(body)
        const request = yield* HttpClientRequest.bodyJson(
          HttpClientRequest.post(new URL('/v2/orders', paperTradingUrl), {
            acceptJson: true,
            headers: credentials(key, secret),
          }),
          body,
        ).pipe(
          Effect.mapError((cause) =>
            invalidRequest(MutationOperation.Submit, 'order request cannot be encoded', cause),
          ),
        )
        return yield* withDeadline(
          MutationOperation.Submit,
          requestHash,
          runtime.operationTimeoutMs,
          Effect.gen(function* () {
            const response = yield* client.execute(request)
            const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
            const headers = yield* decodeHeaders(response).pipe(
              Effect.mapError((cause) =>
                unknownOutcome(
                  MutationOperation.Submit,
                  'Alpaca submit response headers are invalid',
                  requestHash,
                  { status: response.status },
                  cause,
                ),
              ),
            )
            const raw = yield* response.json.pipe(
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
            const contentHash = yield* Effect.try({
              try: () => canonicalHashV1(raw),
              catch: (cause) =>
                unknownOutcome(
                  MutationOperation.Submit,
                  'Alpaca submit response cannot be canonically hashed',
                  requestHash,
                  { status: response.status, requestId: headers['x-request-id'] },
                  cause,
                ),
            })
            const evidence = responseEvidence(headers['x-request-id'], response.status, contentHash, observedAt)

            if (response.status !== 200) {
              const failure = yield* decodeErrorResponse(raw).pipe(
                Effect.mapError((cause) =>
                  unknownOutcome(
                    MutationOperation.Submit,
                    'Alpaca submit error response is invalid',
                    requestHash,
                    evidence,
                    cause,
                  ),
                ),
              )
              if ([400, 401, 403, 404, 422].includes(response.status)) {
                return yield* Effect.fail(knownRejection(requestHash, evidence, failure.code, failure.message))
              }
              return yield* Effect.fail(
                unknownOutcome(
                  MutationOperation.Submit,
                  `Alpaca submit returned ambiguous HTTP ${response.status}`,
                  requestHash,
                  evidence,
                ),
              )
            }

            const decoded = yield* decodeOrderResponse(raw).pipe(
              Effect.mapError((cause) =>
                unknownOutcome(
                  MutationOperation.Submit,
                  'Alpaca submit response does not match the order schema',
                  requestHash,
                  evidence,
                  cause,
                ),
              ),
            )
            const order = yield* Effect.try({
              try: () => normalizeOrder(decoded, runtime.expectedAccountId, observedAt),
              catch: (cause) =>
                unknownOutcome(
                  MutationOperation.Submit,
                  'Alpaca submit response violates the order contract',
                  requestHash,
                  evidence,
                  cause,
                ),
            })
            if (
              order.clientOrderId !== intent.clientOrderId ||
              order.symbol !== intent.symbol ||
              order.side !== body.side ||
              order.orderType !== body.type ||
              order.timeInForce !== body.time_in_force ||
              order.quantityMicros !== intent.quantityMicros ||
              order.extendedHours
            ) {
              return yield* Effect.fail(mismatchedAcceptedOrder(requestHash, evidence, order.brokerOrderId))
            }
            return { requestHash, order, evidence } satisfies SubmitReceipt
          }),
        )
      }).pipe(
        Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
        Effect.withSpan('broker.mutation', {
          attributes: { 'broker.system': 'alpaca', 'broker.operation': MutationOperation.Submit },
        }),
      )

    const cancel = (brokerOrderId: string) =>
      Effect.gen(function* () {
        const orderId = yield* Schema.decodeUnknownEffect(Uuid)(brokerOrderId).pipe(
          Effect.mapError((cause) => invalidRequest(MutationOperation.Cancel, 'invalid Alpaca order ID', cause)),
        )
        const requestHash = cancelRequestHash(orderId)
        const request = HttpClientRequest.delete(
          new URL(`/v2/orders/${encodeURIComponent(orderId)}`, paperTradingUrl),
          { headers: credentials(key, secret) },
        )
        return yield* withDeadline(
          MutationOperation.Cancel,
          requestHash,
          runtime.operationTimeoutMs,
          Effect.gen(function* () {
            const response = yield* client.execute(request)
            const observedAt = new Date(yield* Clock.currentTimeMillis).toISOString()
            const headers = yield* decodeHeaders(response).pipe(
              Effect.mapError((cause) =>
                unknownOutcome(
                  MutationOperation.Cancel,
                  'Alpaca cancel response headers are invalid',
                  requestHash,
                  { status: response.status },
                  cause,
                ),
              ),
            )
            const contentHash =
              response.status === 204
                ? canonicalHashV1(null)
                : yield* response.text.pipe(
                    Effect.flatMap((body) =>
                      Effect.try({
                        try: () => canonicalHashV1(JSON.parse(body)),
                        catch: () => undefined,
                      }).pipe(Effect.orElseSucceed(() => canonicalHashV1(body))),
                    ),
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
            const evidence = responseEvidence(headers['x-request-id'], response.status, contentHash, observedAt)
            if (response.status !== 204) {
              return yield* Effect.fail(
                unknownOutcome(
                  MutationOperation.Cancel,
                  `Alpaca cancel returned HTTP ${response.status}; order lookup is required`,
                  requestHash,
                  evidence,
                ),
              )
            }
            return { requestHash, brokerOrderId: orderId, evidence } satisfies CancelReceipt
          }),
        )
      }).pipe(
        Effect.provideService(Headers.CurrentRedactedNames, redactedHeaders),
        Effect.withSpan('broker.mutation', {
          attributes: { 'broker.system': 'alpaca', 'broker.operation': MutationOperation.Cancel },
        }),
      )

    return { submit, cancel }
  })
