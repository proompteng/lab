import { Data, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1OrThrow, canonicalHashV1Result } from '../../hash'
import {
  Authority,
  IntentSchema,
  IntentState,
  OrderSide as DomainSide,
  OrderType as DomainOrderType,
  TimeInForce as DomainTimeInForce,
  type Intent,
} from '../../paper'
import { StrictNonEmptyStringSchema as NonEmptyString } from '../../schemas'
import {
  AssetClass,
  OrderResponseSchema,
  OrderSide,
  OrderType,
  TimeInForce,
  normalizeOrder,
  type Order,
} from '../alpaca'
import {
  BrokerMutationError,
  MutationOperation,
  configurationError,
  invalidRequest,
  knownRejection,
  mismatchedAcceptedOrder,
  unknownOutcome,
  type CancelReceipt,
  type MutationEvidence,
  type MutationOptions,
  type SubmitReceipt,
} from './model'

const responseParseOptions = { onExcessProperty: 'ignore' } as const
const inputParseOptions = { onExcessProperty: 'error' } as const

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const ErrorCode = Schema.Union([NonEmptyString.check(Schema.isMaxLength(64)), Schema.Int])
const ErrorMessage = NonEmptyString.check(Schema.isMaxLength(1_000))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))

const ErrorResponseSchema = Schema.Struct({
  code: ErrorCode,
  message: ErrorMessage,
})
const OptionsSchema = Schema.Struct({
  expectedAccountId: Uuid,
  maximumAuthority: Schema.Enum(Authority),
  operationTimeoutMs: PositiveInteger,
})

const decodeErrorResponse = Schema.decodeUnknownResult(ErrorResponseSchema, responseParseOptions)
const decodeOrderResponse = Schema.decodeUnknownResult(OrderResponseSchema, responseParseOptions)
const decodeIntent = Schema.decodeUnknownResult(IntentSchema, inputParseOptions)
const decodeOptions = Schema.decodeUnknownResult(OptionsSchema, inputParseOptions)
const decodeOrderId = Schema.decodeUnknownResult(Uuid)
const decodeJsonResponseBody = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)

export interface ResolvedMutationOptions {
  readonly expectedAccountId: string
  readonly operationTimeoutMs: number
  readonly key: string
  readonly secret: string
  readonly proxyUrl: string
}

export interface OrderRequestBody {
  readonly symbol: string
  readonly qty: string
  readonly side: OrderSide
  readonly type: OrderType.Market
  readonly time_in_force: TimeInForce
  readonly client_order_id: string
  readonly extended_hours: false
}

export class OrderRequestError extends Data.TaggedError('OrderRequestError')<{
  readonly failure: 'invalid-intent-state' | 'invalid-order'
  readonly message: string
  readonly intentState?: IntentState
  readonly orderType?: DomainOrderType
  readonly timeInForce?: DomainTimeInForce
  readonly quantityMicros?: string
}> {}

export interface PreparedSubmit {
  readonly intent: Intent
  readonly request: OrderRequestBody
  readonly requestHash: string
}

export interface PreparedCancel {
  readonly brokerOrderId: string
  readonly requestHash: string
}

export interface SubmitResponseFacts extends PreparedSubmit {
  readonly status: number
  readonly requestId: string
  readonly body: unknown
  readonly observedAt: string
}

export interface CancelResponseFacts extends PreparedCancel {
  readonly status: number
  readonly requestId: string
  readonly body?: string
  readonly observedAt: string
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

const quantityMicros = (value: string): Result.Result<bigint, OrderRequestError> =>
  /^[1-9][0-9]*$/.test(value)
    ? Result.succeed(BigInt(value))
    : Result.fail(
        new OrderRequestError({
          failure: 'invalid-order',
          message: 'order quantity must be canonical positive micros',
          quantityMicros: value,
        }),
      )

const microsToDecimal = (micros: bigint): string => {
  const whole = micros / 1_000_000n
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`
}

export const resolveMutationOptions = (
  options: MutationOptions,
): Result.Result<ResolvedMutationOptions, BrokerMutationError> => {
  const decoded = decodeOptions({
    expectedAccountId: options.expectedAccountId,
    maximumAuthority: options.maximumAuthority,
    operationTimeoutMs: options.operationTimeoutMs,
  })
  if (Result.isFailure(decoded)) {
    return Result.fail(configurationError('invalid Alpaca mutation options', decoded.failure))
  }
  if (decoded.success.maximumAuthority !== Authority.Paper) {
    return Result.fail(configurationError('Alpaca mutation capability requires explicit PAPER maximum authority'))
  }
  const key = Redacted.value(options.key)
  const secret = Redacted.value(options.secret)
  if (key.length === 0 || key.trim() !== key || secret.length === 0 || secret.trim() !== secret) {
    return Result.fail(configurationError('Alpaca credentials must be non-empty without surrounding whitespace'))
  }
  return Result.succeed({
    expectedAccountId: decoded.success.expectedAccountId,
    operationTimeoutMs: decoded.success.operationTimeoutMs,
    key,
    secret,
    proxyUrl: options.proxyUrl,
  })
}

export const orderRequestBody = (intent: Intent): Result.Result<OrderRequestBody, OrderRequestError> => {
  if (intent.orderType !== DomainOrderType.Market) {
    return Result.fail(
      new OrderRequestError({
        failure: 'invalid-order',
        message: 'Bayn broker submission supports market orders only',
        orderType: intent.orderType,
      }),
    )
  }
  const quantity = quantityMicros(intent.quantityMicros)
  if (Result.isFailure(quantity)) return Result.fail(quantity.failure)
  if (intent.timeInForce !== DomainTimeInForce.Day && quantity.success % 1_000_000n !== 0n) {
    return Result.fail(
      new OrderRequestError({
        failure: 'invalid-order',
        message: 'fractional market orders require DAY time in force',
        timeInForce: intent.timeInForce,
        quantityMicros: intent.quantityMicros,
      }),
    )
  }
  return Result.succeed({
    symbol: intent.symbol,
    qty: microsToDecimal(quantity.success),
    side: side(intent.side),
    type: OrderType.Market,
    time_in_force: timeInForce(intent.timeInForce),
    client_order_id: intent.clientOrderId,
    extended_hours: false,
  })
}

export const submitBody = (intent: Intent): Result.Result<OrderRequestBody, OrderRequestError> =>
  intent.state === IntentState.IoStarted
    ? orderRequestBody(intent)
    : Result.fail(
        new OrderRequestError({
          failure: 'invalid-intent-state',
          message: 'intent must be IO_STARTED before broker submission',
          intentState: intent.state,
        }),
      )

const submitRequestHash = (body: OrderRequestBody): Result.Result<string, BrokerMutationError> =>
  Result.mapError(canonicalHashV1Result(body), (cause) =>
    invalidRequest(MutationOperation.Submit, 'order request cannot be canonically hashed', cause),
  )

export const prepareSubmit = (
  input: unknown,
  expectedAccountId: string,
): Result.Result<PreparedSubmit, BrokerMutationError> => {
  const decoded = decodeIntent(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(invalidRequest(MutationOperation.Submit, 'invalid order intent', decoded.failure))
  }
  const intent = decoded.success
  if (intent.accountId !== expectedAccountId) {
    return Result.fail(
      invalidRequest(MutationOperation.Submit, 'order intent account does not match the configured Alpaca account'),
    )
  }
  const body = submitBody(intent)
  if (Result.isFailure(body)) {
    return Result.fail(invalidRequest(MutationOperation.Submit, 'order intent cannot be submitted', body.failure))
  }
  return Result.map(submitRequestHash(body.success), (requestHash) => ({
    intent,
    request: body.success,
    requestHash,
  }))
}

export const cancelRequestHash = (brokerOrderId: string): string =>
  canonicalHashV1OrThrow({ operation: MutationOperation.Cancel, brokerOrderId })

export const prepareCancel = (input: unknown): Result.Result<PreparedCancel, BrokerMutationError> => {
  const decoded = decodeOrderId(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(invalidRequest(MutationOperation.Cancel, 'invalid Alpaca order ID', decoded.failure))
  }
  const brokerOrderId = decoded.success
  return Result.mapError(
    Result.map(canonicalHashV1Result({ operation: MutationOperation.Cancel, brokerOrderId }), (requestHash) => ({
      brokerOrderId,
      requestHash,
    })),
    (cause) => invalidRequest(MutationOperation.Cancel, 'cancel request cannot be canonically hashed', cause),
  )
}

const responseEvidence = (
  requestId: string,
  status: number,
  contentHash: string,
  observedAt: string,
): MutationEvidence => ({ requestId, status, contentHash, observedAt })

const canonicalSubmitResponseHash = (facts: SubmitResponseFacts): Result.Result<string, BrokerMutationError> =>
  Result.mapError(canonicalHashV1Result(facts.body), (cause) =>
    unknownOutcome(
      MutationOperation.Submit,
      'Alpaca submit response cannot be canonically hashed',
      facts.requestHash,
      { status: facts.status, requestId: facts.requestId },
      cause,
    ),
  )

const canonicalCancelResponseHash = (facts: CancelResponseFacts): Result.Result<string, BrokerMutationError> => {
  if (facts.status === 204) {
    return Result.mapError(canonicalHashV1Result(null), (cause) =>
      unknownOutcome(
        MutationOperation.Cancel,
        'Alpaca cancel response cannot be canonically hashed',
        facts.requestHash,
        { status: facts.status, requestId: facts.requestId },
        cause,
      ),
    )
  }
  if (facts.body === undefined) {
    return Result.fail(
      unknownOutcome(MutationOperation.Cancel, 'Alpaca cancel response body is missing', facts.requestHash, {
        status: facts.status,
        requestId: facts.requestId,
      }),
    )
  }
  const decoded = decodeJsonResponseBody(facts.body)
  const material = Result.isSuccess(decoded) ? decoded.success : facts.body
  return Result.mapError(canonicalHashV1Result(material), (cause) =>
    unknownOutcome(
      MutationOperation.Cancel,
      'Alpaca cancel response cannot be canonically hashed',
      facts.requestHash,
      { status: facts.status, requestId: facts.requestId },
      cause,
    ),
  )
}

const normalizeAcceptedOrder = (
  raw: typeof OrderResponseSchema.Type,
  facts: SubmitResponseFacts,
  evidence: MutationEvidence,
): Result.Result<Order, BrokerMutationError> =>
  Result.try({
    try: () => normalizeOrder(raw, facts.intent.accountId, facts.observedAt),
    catch: (cause) =>
      unknownOutcome(
        MutationOperation.Submit,
        'Alpaca submit response violates the order contract',
        facts.requestHash,
        evidence,
        cause,
      ),
  })

const acceptedOrderMatches = (order: Order, facts: SubmitResponseFacts): boolean =>
  order.accountId === facts.intent.accountId &&
  order.assetClass === AssetClass.UsEquity &&
  order.clientOrderId === facts.intent.clientOrderId &&
  order.symbol === facts.intent.symbol &&
  order.side === facts.request.side &&
  order.orderType === facts.request.type &&
  order.timeInForce === facts.request.time_in_force &&
  order.quantityMicros === facts.intent.quantityMicros &&
  !order.extendedHours

export const classifySubmitResponse = (
  facts: SubmitResponseFacts,
): Result.Result<SubmitReceipt, BrokerMutationError> => {
  const contentHash = canonicalSubmitResponseHash(facts)
  if (Result.isFailure(contentHash)) return Result.fail(contentHash.failure)
  const evidence = responseEvidence(facts.requestId, facts.status, contentHash.success, facts.observedAt)

  if (facts.status !== 200) {
    const failure = decodeErrorResponse(facts.body)
    if (Result.isFailure(failure)) {
      return Result.fail(
        unknownOutcome(
          MutationOperation.Submit,
          'Alpaca submit error response is invalid',
          facts.requestHash,
          evidence,
          failure.failure,
        ),
      )
    }
    if ([400, 401, 403, 404, 422].includes(facts.status)) {
      return Result.fail(knownRejection(facts.requestHash, evidence, failure.success.code, failure.success.message))
    }
    return Result.fail(
      unknownOutcome(
        MutationOperation.Submit,
        `Alpaca submit returned ambiguous HTTP ${facts.status}`,
        facts.requestHash,
        evidence,
      ),
    )
  }

  const decoded = decodeOrderResponse(facts.body)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      unknownOutcome(
        MutationOperation.Submit,
        'Alpaca submit response does not match the order schema',
        facts.requestHash,
        evidence,
        decoded.failure,
      ),
    )
  }
  const order = normalizeAcceptedOrder(decoded.success, facts, evidence)
  if (Result.isFailure(order)) return Result.fail(order.failure)
  if (!acceptedOrderMatches(order.success, facts)) {
    return Result.fail(mismatchedAcceptedOrder(facts.requestHash, evidence, order.success.brokerOrderId))
  }
  return Result.succeed({ requestHash: facts.requestHash, order: order.success, evidence })
}

export const classifyCancelResponse = (
  facts: CancelResponseFacts,
): Result.Result<CancelReceipt, BrokerMutationError> => {
  const contentHash = canonicalCancelResponseHash(facts)
  if (Result.isFailure(contentHash)) return Result.fail(contentHash.failure)
  const evidence = responseEvidence(facts.requestId, facts.status, contentHash.success, facts.observedAt)
  return facts.status === 204
    ? Result.succeed({ requestHash: facts.requestHash, brokerOrderId: facts.brokerOrderId, evidence })
    : Result.fail(
        unknownOutcome(
          MutationOperation.Cancel,
          `Alpaca cancel returned HTTP ${facts.status}; order lookup is required`,
          facts.requestHash,
          evidence,
        ),
      )
}
