import { Data, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1OrThrow, canonicalHashV1Result } from '../../hash'
import { BrokerAccess, type ExecutionAuthority } from '../../execution/authority'
import {
  IntentSchema,
  IntentState,
  OrderSide as DomainSide,
  OrderType as DomainOrderType,
  TimeInForce as DomainTimeInForce,
  type Intent,
} from '../../paper'
import { AssetClass, OrderSide, OrderType, TimeInForce, type BrokerSessionShape, type Order } from '../alpaca'
import { decodeErrorResponse, decodeOrder } from '../alpaca/model'
import { normalizeOrderResult } from '../alpaca/normalizers'
import type { BrokerConnection } from '../connection'
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
  type SubmitReceipt,
} from './model'
import { Pipeable } from '../../pipeable'

const inputParseOptions = { onExcessProperty: 'error' } as const

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const decodeIntent = Schema.decodeUnknownResult(IntentSchema, inputParseOptions)
const decodeOrderId = Schema.decodeUnknownResult(Uuid)
const decodeJsonResponseBody = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)

export interface ResolvedMutationCapability {
  readonly connection: BrokerConnection
  readonly expectedAccountId: string
  readonly operationTimeoutMs: number
  readonly key: string
  readonly secret: string
}

export interface BuyNotionalMarketOrderRequestBody {
  readonly symbol: string
  readonly notional: string
  readonly side: OrderSide
  readonly type: OrderType.Market
  readonly time_in_force: TimeInForce
  readonly client_order_id: string
  readonly extended_hours: false
}

export interface SellQuantityMarketOrderRequestBody {
  readonly symbol: string
  readonly qty: string
  readonly side: OrderSide
  readonly type: OrderType.Market
  readonly time_in_force: TimeInForce
  readonly client_order_id: string
  readonly extended_hours: false
}

export type OrderRequestBody = BuyNotionalMarketOrderRequestBody | SellQuantityMarketOrderRequestBody

export interface LegacyBoundedLimitOrderRequestBody {
  readonly symbol: string
  readonly qty: string
  readonly side: OrderSide
  readonly type: OrderType.Limit
  readonly time_in_force: TimeInForce
  readonly limit_price: string
  readonly client_order_id: string
  readonly extended_hours: false
}

export type HistoricalMarketOrderRequestBody = SellQuantityMarketOrderRequestBody

export type CompatibleOrderRequestBody =
  | OrderRequestBody
  | LegacyBoundedLimitOrderRequestBody
  | HistoricalMarketOrderRequestBody

export type OrderRequestIntent = Pick<
  Intent,
  'clientOrderId' | 'notionalLimitMicros' | 'orderType' | 'quantityMicros' | 'side' | 'symbol' | 'timeInForce'
>

export class OrderRequestError extends Data.TaggedError('OrderRequestError')<{
  readonly failure: 'invalid-intent-state' | 'invalid-order'
  readonly message: string
  readonly intentState?: IntentState
  readonly orderType?: DomainOrderType
  readonly timeInForce?: DomainTimeInForce
  readonly quantityMicros?: string
  readonly notionalLimitMicros?: string
  readonly requestHash?: string
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

const notionalMicros = (value: string): Result.Result<bigint, OrderRequestError> =>
  /^[1-9][0-9]*$/.test(value)
    ? Result.succeed(BigInt(value))
    : Result.fail(
        new OrderRequestError({
          failure: 'invalid-order',
          message: 'order notional limit must be canonical positive micros',
          notionalLimitMicros: value,
        }),
      )

const microsToDecimal = (micros: bigint): string => {
  const whole = micros / 1_000_000n
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`
}

const alpacaLimitPriceIncrementMicros = (priceMicros: bigint): bigint => (priceMicros >= 1_000_000n ? 10_000n : 100n)

const quantizeDown = (value: bigint, increment: bigint): bigint => (value / increment) * increment
const quantizeUp = (value: bigint, increment: bigint): bigint => ((value + increment - 1n) / increment) * increment

export const orderPriceBoundaryMicros = (intent: OrderRequestIntent): Result.Result<bigint, OrderRequestError> => {
  const quantity = quantityMicros(intent.quantityMicros)
  if (Result.isFailure(quantity)) return Result.fail(quantity.failure)
  const notional = notionalMicros(intent.notionalLimitMicros)
  if (Result.isFailure(notional)) return Result.fail(notional.failure)
  const numerator = notional.success * 1_000_000n
  const unquantized =
    intent.side === DomainSide.Buy
      ? numerator / quantity.success
      : (numerator + quantity.success - 1n) / quantity.success
  const increment = alpacaLimitPriceIncrementMicros(unquantized)
  const price =
    intent.side === DomainSide.Buy ? quantizeDown(unquantized, increment) : quantizeUp(unquantized, increment)
  return price > 0n
    ? Result.succeed(price)
    : Result.fail(
        new OrderRequestError({
          failure: 'invalid-order',
          message: 'order price boundary must be positive',
          quantityMicros: intent.quantityMicros,
          notionalLimitMicros: intent.notionalLimitMicros,
        }),
      )
}

export const authorizeMutationAccess = (
  authority: ExecutionAuthority,
): Result.Result<BrokerAccess.Mutation, BrokerMutationError> => {
  if (authority.brokerAccess !== BrokerAccess.Mutation) {
    return Result.fail(
      configurationError({ message: 'Alpaca mutation capability requires explicit mutation broker access' }),
    )
  }
  return Result.succeed(BrokerAccess.Mutation)
}

const resolveMutationCapabilityDataFirst = (
  session: BrokerSessionShape,
  authority: ExecutionAuthority,
): Result.Result<ResolvedMutationCapability, BrokerMutationError> => {
  const connection = session.connection
  const preflight = session.preflight
  if (
    preflight.provider !== connection.provider ||
    preflight.environment !== connection.environment ||
    preflight.baseUrl !== connection.baseUrl ||
    preflight.accountId !== connection.expectedAccountId
  ) {
    return Result.fail(
      configurationError({
        message: 'Alpaca mutation capability requires an exact verified broker session binding',
        cause: {
          _tag: 'BrokerSessionBindingMismatch',
          connectionProvider: connection.provider,
          preflightProvider: preflight.provider,
          connectionEnvironment: connection.environment,
          preflightEnvironment: preflight.environment,
          connectionBaseUrl: connection.baseUrl,
          preflightBaseUrl: preflight.baseUrl,
          connectionAccountId: connection.expectedAccountId,
          preflightAccountId: preflight.accountId,
        },
      }),
    )
  }
  return Result.gen(function* () {
    yield* authorizeMutationAccess(authority)
    if (authority.brokerIdentity.identityHash !== connection.identity.identityHash) {
      return yield* Result.fail(
        configurationError({
          message: 'Alpaca mutation authority identity does not match the verified broker session',
          cause: {
            _tag: 'BrokerIdentityMismatch',
            authorityIdentityHash: authority.brokerIdentity.identityHash,
            connectionIdentityHash: connection.identity.identityHash,
          },
        }),
      )
    }
    return {
      connection,
      expectedAccountId: connection.expectedAccountId,
      operationTimeoutMs: connection.operationTimeoutMs,
      key: Redacted.value(connection.key),
      secret: Redacted.value(connection.secret),
    }
  })
}

export const resolveMutationCapability = Pipeable.dual(2, resolveMutationCapabilityDataFirst)

export const historicalMarketOrderRequestBody = (
  intent: OrderRequestIntent,
): Result.Result<HistoricalMarketOrderRequestBody, OrderRequestError> => {
  if (intent.orderType !== DomainOrderType.Market) {
    return Result.fail(
      new OrderRequestError({
        failure: 'invalid-order',
        message: 'historical Bayn broker submission supported market orders only',
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

export const legacyBoundedLimitOrderRequestBody = (
  intent: OrderRequestIntent,
): Result.Result<LegacyBoundedLimitOrderRequestBody, OrderRequestError> => {
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
  const priceBoundary = orderPriceBoundaryMicros(intent)
  if (Result.isFailure(priceBoundary)) return Result.fail(priceBoundary.failure)
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
    type: OrderType.Limit,
    time_in_force: timeInForce(intent.timeInForce),
    limit_price: microsToDecimal(priceBoundary.success),
    client_order_id: intent.clientOrderId,
    extended_hours: false,
  })
}

export const orderRequestBody = (intent: OrderRequestIntent): Result.Result<OrderRequestBody, OrderRequestError> => {
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
  const notional = notionalMicros(intent.notionalLimitMicros)
  if (Result.isFailure(notional)) return Result.fail(notional.failure)
  if (intent.timeInForce !== DomainTimeInForce.Day) {
    return Result.fail(
      new OrderRequestError({
        failure: 'invalid-order',
        message: 'fractional market orders require DAY time in force',
        timeInForce: intent.timeInForce,
        quantityMicros: intent.quantityMicros,
      }),
    )
  }
  const common = {
    symbol: intent.symbol,
    side: side(intent.side),
    type: OrderType.Market,
    time_in_force: timeInForce(intent.timeInForce),
    client_order_id: intent.clientOrderId,
    extended_hours: false,
  } as const
  return intent.side === DomainSide.Buy
    ? Result.succeed({ ...common, notional: microsToDecimal(notional.success) })
    : Result.succeed({ ...common, qty: microsToDecimal(quantity.success) })
}

export const compatibleOrderRequestBody = (
  intent: OrderRequestIntent,
  requestHash: string,
): Result.Result<CompatibleOrderRequestBody, OrderRequestError> => {
  const candidates: CompatibleOrderRequestBody[] = []
  const current = orderRequestBody(intent)
  if (Result.isSuccess(current)) candidates.push(current.success)
  const bounded = legacyBoundedLimitOrderRequestBody(intent)
  if (Result.isSuccess(bounded)) candidates.push(bounded.success)
  const historical = historicalMarketOrderRequestBody(intent)
  if (Result.isSuccess(historical)) candidates.push(historical.success)
  for (const candidate of candidates) {
    const candidateHash = canonicalHashV1Result(candidate)
    if (Result.isFailure(candidateHash)) {
      return Result.fail(
        new OrderRequestError({
          failure: 'invalid-order',
          message: 'compatible order request cannot be canonically hashed',
          requestHash,
        }),
      )
    }
    if (candidateHash.success === requestHash) return Result.succeed(candidate)
  }
  return Result.fail(
    new OrderRequestError({
      failure: 'invalid-order',
      message: 'durable submit request hash does not match a supported order representation',
      requestHash,
    }),
  )
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
    invalidRequest({
      operation: MutationOperation.Submit,
      message: 'order request cannot be canonically hashed',
      cause,
    }),
  )

const prepareSubmitDataFirst = (
  input: unknown,
  expectedAccountId: string,
): Result.Result<PreparedSubmit, BrokerMutationError> => {
  const decoded = decodeIntent(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      invalidRequest({ operation: MutationOperation.Submit, message: 'invalid order intent', cause: decoded.failure }),
    )
  }
  const intent = decoded.success
  if (intent.accountId !== expectedAccountId) {
    return Result.fail(
      invalidRequest({
        operation: MutationOperation.Submit,
        message: 'order intent account does not match the configured Alpaca account',
      }),
    )
  }
  const body = submitBody(intent)
  if (Result.isFailure(body)) {
    return Result.fail(
      invalidRequest({
        operation: MutationOperation.Submit,
        message: 'order intent cannot be submitted',
        cause: body.failure,
      }),
    )
  }
  return Result.map(submitRequestHash(body.success), (requestHash) => ({
    intent,
    request: body.success,
    requestHash,
  }))
}

export const prepareSubmit = Pipeable.dual(2, prepareSubmitDataFirst)

export const cancelRequestHash = (brokerOrderId: string): string =>
  canonicalHashV1OrThrow({ operation: MutationOperation.Cancel, brokerOrderId })

export const prepareCancel = (input: unknown): Result.Result<PreparedCancel, BrokerMutationError> => {
  const decoded = decodeOrderId(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      invalidRequest({
        operation: MutationOperation.Cancel,
        message: 'invalid Alpaca order ID',
        cause: decoded.failure,
      }),
    )
  }
  const brokerOrderId = decoded.success
  return Result.mapError(
    Result.map(canonicalHashV1Result({ operation: MutationOperation.Cancel, brokerOrderId }), (requestHash) => ({
      brokerOrderId,
      requestHash,
    })),
    (cause) =>
      invalidRequest({
        operation: MutationOperation.Cancel,
        message: 'cancel request cannot be canonically hashed',
        cause,
      }),
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
    unknownOutcome({
      operation: MutationOperation.Submit,
      message: 'Alpaca submit response cannot be canonically hashed',
      requestHash: facts.requestHash,
      evidence: { status: facts.status, requestId: facts.requestId },
      cause,
    }),
  )

const canonicalCancelResponseHash = (facts: CancelResponseFacts): Result.Result<string, BrokerMutationError> => {
  if (facts.status === 204) {
    return Result.mapError(canonicalHashV1Result(null), (cause) =>
      unknownOutcome({
        operation: MutationOperation.Cancel,
        message: 'Alpaca cancel response cannot be canonically hashed',
        requestHash: facts.requestHash,
        evidence: { status: facts.status, requestId: facts.requestId },
        cause,
      }),
    )
  }
  if (facts.body === undefined) {
    return Result.fail(
      unknownOutcome({
        operation: MutationOperation.Cancel,
        message: 'Alpaca cancel response body is missing',
        requestHash: facts.requestHash,
        evidence: {
          status: facts.status,
          requestId: facts.requestId,
        },
      }),
    )
  }
  const decoded = decodeJsonResponseBody(facts.body)
  const material = Result.isSuccess(decoded) ? decoded.success : facts.body
  return Result.mapError(canonicalHashV1Result(material), (cause) =>
    unknownOutcome({
      operation: MutationOperation.Cancel,
      message: 'Alpaca cancel response cannot be canonically hashed',
      requestHash: facts.requestHash,
      evidence: { status: facts.status, requestId: facts.requestId },
      cause,
    }),
  )
}

const normalizeAcceptedOrder = (
  raw: Parameters<typeof normalizeOrderResult>[0],
  facts: SubmitResponseFacts,
  evidence: MutationEvidence,
): Result.Result<Order, BrokerMutationError> =>
  Result.mapError(normalizeOrderResult(raw, facts.intent.accountId, facts.observedAt), (cause) =>
    unknownOutcome({
      operation: MutationOperation.Submit,
      message: 'Alpaca submit response violates the order contract',
      requestHash: facts.requestHash,
      evidence,
      cause,
    }),
  )

const acceptedOrderMatches = (order: Order, facts: SubmitResponseFacts): boolean => {
  const commonMatches =
    order.accountId === facts.intent.accountId &&
    order.assetClass === AssetClass.UsEquity &&
    order.clientOrderId === facts.intent.clientOrderId &&
    order.symbol === facts.intent.symbol &&
    order.side === facts.request.side &&
    order.orderType === facts.request.type &&
    order.timeInForce === facts.request.time_in_force &&
    order.limitPriceMicros === undefined &&
    !order.extendedHours
  if (!commonMatches) return false
  return 'notional' in facts.request
    ? order.quantityMicros === undefined && order.notionalMicros === facts.intent.notionalLimitMicros
    : order.quantityMicros === facts.intent.quantityMicros && order.notionalMicros === undefined
}

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
        unknownOutcome({
          operation: MutationOperation.Submit,
          message: 'Alpaca submit error response is invalid',
          requestHash: facts.requestHash,
          evidence,
          cause: failure.failure,
        }),
      )
    }
    if ([400, 401, 403, 404, 422].includes(facts.status)) {
      return Result.fail(knownRejection(facts.requestHash, evidence, failure.success.code, failure.success.message))
    }
    return Result.fail(
      unknownOutcome({
        operation: MutationOperation.Submit,
        message: `Alpaca submit returned ambiguous HTTP ${facts.status}`,
        requestHash: facts.requestHash,
        evidence,
      }),
    )
  }

  const decoded = decodeOrder(facts.body)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      unknownOutcome({
        operation: MutationOperation.Submit,
        message: 'Alpaca submit response does not match the order schema',
        requestHash: facts.requestHash,
        evidence,
        cause: decoded.failure,
      }),
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
        unknownOutcome({
          operation: MutationOperation.Cancel,
          message: `Alpaca cancel returned HTTP ${facts.status}; order lookup is required`,
          requestHash: facts.requestHash,
          evidence,
        }),
      )
}
