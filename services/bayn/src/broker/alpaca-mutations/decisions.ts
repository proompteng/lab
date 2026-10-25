import { cashSpotLimitTimeInForce } from '../../execution/order-terms'
import { Data, Redacted, Result, Schema } from 'effect'
import { SubmissionDenialReason } from '../../execution/submission-denial'

import { canonicalHashV1Result } from '../../hash'
import { BrokerAccess, type ExecutionAuthority } from '../../execution/authority'
import {
  IntentSchema,
  IntentState,
  OrderSide as DomainSide,
  OrderType as DomainOrderType,
  TimeInForce as DomainTimeInForce,
  type Intent,
} from '../../execution/contracts'
import { AssetClass, OrderSide, OrderType, TimeInForce, type Order } from '../alpaca/model'
import { type BrokerSessionShape } from '../alpaca/session'
import { quantizeInstrumentPriceMicros } from '../alpaca-price'
import { decodeErrorResponse, decodeOrder } from '../alpaca/model'
import { normalizeOrderResult } from '../alpaca/normalizers'
import { verifyProtectionGroup } from '../alpaca/protection-group'
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

import { quantityScale, quantityToDecimal } from '../../quantity'
import { instrumentMarket, MarketKind } from '../../instruments'

const inputParseOptions = { onExcessProperty: 'error' } as const

const Uuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)
const decodeIntent = Schema.decodeUnknownResult(IntentSchema, inputParseOptions)
const decodeOrderId = Schema.decodeUnknownResult(Uuid)
const decodeJsonResponseBody = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

export interface ResolvedMutationCapability {
  readonly connection: BrokerConnection
  readonly expectedAccountId: string
  readonly operationTimeoutMs: number
  readonly fractionalTrading: boolean
  readonly key: string
  readonly secret: string
}

export interface OrderRequestBody {
  readonly symbol: string
  readonly qty: string
  readonly side: OrderSide
  readonly type: OrderType.Limit | OrderType.StopLimit
  readonly time_in_force: TimeInForce.Day | TimeInForce.ImmediateOrCancel | TimeInForce.GoodUntilCanceled
  readonly limit_price: string
  readonly stop_price?: string
  readonly order_class?: 'bracket' | 'oco'
  readonly take_profit?: { readonly limit_price: string }
  readonly stop_loss?: { readonly stop_price: string; readonly limit_price: string }
  readonly client_order_id: string
  readonly extended_hours: boolean
}

export type OrderRequestIntent = Pick<
  Intent,
  'clientOrderId' | 'notionalLimitMicros' | 'limitPriceMicros' | 'quantityAtoms' | 'side' | 'symbol' | 'protection'
> & { readonly orderType: DomainOrderType; readonly timeInForce: DomainTimeInForce }

export class OrderRequestError extends Data.TaggedError('OrderRequestError')<{
  readonly failure: 'invalid-intent-state' | 'invalid-order'
  readonly message: string
  readonly intentState?: IntentState
  readonly orderType?: DomainOrderType
  readonly timeInForce?: DomainTimeInForce
  readonly quantityAtoms?: string
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

const quantityAtoms = (value: string): Result.Result<bigint, OrderRequestError> =>
  /^[1-9][0-9]*$/.test(value)
    ? Result.succeed(BigInt(value))
    : Result.fail(
        new OrderRequestError({
          failure: 'invalid-order',
          message: 'order quantity must be canonical positive micros',
          quantityAtoms: value,
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

const decimalToMicros = (decimal: string): string | undefined => {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(decimal)
  if (match === null) return undefined
  const whole = match[1]
  if (whole === undefined) return undefined
  const fraction = match[2] ?? ''
  return (BigInt(whole) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6))).toString()
}

export const orderPriceBoundaryMicros = (
  intent: Pick<OrderRequestIntent, 'symbol' | 'side' | 'quantityAtoms' | 'notionalLimitMicros' | 'limitPriceMicros'>,
): Result.Result<bigint, OrderRequestError> => {
  const quantity = quantityAtoms(intent.quantityAtoms)
  if (Result.isFailure(quantity)) return Result.fail(quantity.failure)
  const notional = notionalMicros(intent.notionalLimitMicros)
  if (Result.isFailure(notional)) return Result.fail(notional.failure)
  const price = notionalMicros(intent.limitPriceMicros)
  if (Result.isFailure(price)) return Result.fail(price.failure)
  const buy = intent.side === DomainSide.Buy
  const expectedNotional = (quantity.success * price.success + (buy ? quantityScale - 1n : 0n)) / quantityScale
  if (
    expectedNotional !== notional.success ||
    quantizeInstrumentPriceMicros(intent.symbol, price.success, buy ? 'DOWN' : 'UP') !== price.success
  )
    return Result.fail(
      new OrderRequestError({
        failure: 'invalid-order',
        message: 'explicit limit price and rounded notional do not describe the same order',
        quantityAtoms: intent.quantityAtoms,
        notionalLimitMicros: intent.notionalLimitMicros,
      }),
    )
  return Result.succeed(price.success)
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

export const resolveMutationCapability = (
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
      fractionalTrading: preflight.fractionalTrading,
      key: Redacted.value(connection.key),
      secret: Redacted.value(connection.secret),
    }
  })
}

export const orderRequestBody = (intent: OrderRequestIntent): Result.Result<OrderRequestBody, OrderRequestError> => {
  const crypto = instrumentMarket(intent.symbol) === MarketKind.Crypto
  const protective = intent.protection
  const stop = protective?._tag === 'StopLimit'
  const grouped = protective?._tag === 'Bracket' || protective?._tag === 'Oco'
  const expectedDuration = stop
    ? crypto
      ? DomainTimeInForce.GoodUntilCanceled
      : DomainTimeInForce.Day
    : cashSpotLimitTimeInForce(instrumentMarket(intent.symbol))
  const quantity = quantityAtoms(intent.quantityAtoms)
  if (Result.isFailure(quantity)) return Result.fail(quantity.failure)
  if (
    intent.orderType !== (stop ? DomainOrderType.StopLimit : DomainOrderType.Limit) ||
    intent.timeInForce !== expectedDuration ||
    (protective !== undefined &&
      (protective._tag === 'Bracket' ? intent.side !== DomainSide.Buy : intent.side !== DomainSide.Sell)) ||
    (grouped && (crypto || quantity.success % quantityScale !== 0n))
  )
    return Result.fail(
      new OrderRequestError({
        failure: 'invalid-order',
        message: 'order terms violate the instrument protection contract',
        orderType: intent.orderType,
        timeInForce: intent.timeInForce,
      }),
    )
  const price = orderPriceBoundaryMicros(intent)
  if (Result.isFailure(price)) return Result.fail(price.failure)
  if (protective !== undefined) {
    const stopPrice = BigInt(protective.stopPriceMicros)
    if (
      stopPrice <= 0n ||
      quantizeInstrumentPriceMicros(intent.symbol, stopPrice, 'DOWN') !== stopPrice ||
      (stop && price.success > stopPrice) ||
      (grouped &&
        (quantizeInstrumentPriceMicros(intent.symbol, BigInt(protective.stopLimitPriceMicros), 'UP') !==
          BigInt(protective.stopLimitPriceMicros) ||
          quantizeInstrumentPriceMicros(intent.symbol, BigInt(protective.profitLimitPriceMicros), 'UP') !==
            BigInt(protective.profitLimitPriceMicros) ||
          BigInt(protective.stopLimitPriceMicros) > stopPrice ||
          stopPrice >= BigInt(protective.profitLimitPriceMicros))) ||
      (protective._tag === 'Oco' && intent.limitPriceMicros !== protective.profitLimitPriceMicros)
    )
      return Result.fail(
        new OrderRequestError({
          failure: 'invalid-order',
          message: 'protection prices are invalid or exceed venue precision',
        }),
      )
  }
  return Result.succeed({
    symbol: intent.symbol,
    qty: quantityToDecimal(quantity.success),
    side: side(intent.side),
    type: stop ? OrderType.StopLimit : OrderType.Limit,
    time_in_force:
      stop && crypto ? TimeInForce.GoodUntilCanceled : crypto ? TimeInForce.ImmediateOrCancel : TimeInForce.Day,
    limit_price: microsToDecimal(price.success),
    ...(stop ? { stop_price: microsToDecimal(BigInt(protective.stopPriceMicros)) } : {}),
    ...(grouped
      ? {
          order_class: protective._tag === 'Bracket' ? ('bracket' as const) : ('oco' as const),
          take_profit: { limit_price: microsToDecimal(BigInt(protective.profitLimitPriceMicros)) },
          stop_loss: {
            stop_price: microsToDecimal(BigInt(protective.stopPriceMicros)),
            limit_price: microsToDecimal(BigInt(protective.stopLimitPriceMicros)),
          },
        }
      : {}),
    client_order_id: intent.clientOrderId,
    extended_hours: !crypto && protective === undefined,
  })
}

export const orderRequestRequiresFractionalTrading = (request: OrderRequestBody): boolean =>
  instrumentMarket(request.symbol) === MarketKind.Equity && request.qty.includes('.')

export const recordedOrderRequestBody = (
  intent: OrderRequestIntent,
  requestHash: string,
): Result.Result<OrderRequestBody, OrderRequestError> =>
  Result.gen(function* () {
    const request = yield* orderRequestBody(intent)
    const actualHash = yield* canonicalHashV1Result(request).pipe(
      Result.mapError(
        () =>
          new OrderRequestError({
            failure: 'invalid-order',
            message: 'current order request cannot be canonically hashed',
            requestHash,
          }),
      ),
    )
    if (actualHash !== requestHash)
      return yield* Result.fail(
        new OrderRequestError({
          failure: 'invalid-order',
          message: 'durable submit hash differs from the current order contract',
          requestHash,
        }),
      )
    return request
  })

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
      denialReason: SubmissionDenialReason.RequestEncoding,
      cause,
    }),
  )

export const prepareSubmit = (
  input: unknown,
  expectedAccountId: string,
): Result.Result<PreparedSubmit, BrokerMutationError> => {
  const decoded = decodeIntent(input)
  if (Result.isFailure(decoded)) {
    return Result.fail(
      invalidRequest({
        operation: MutationOperation.Submit,
        message: 'invalid order intent',
        cause: decoded.failure,
        denialReason: SubmissionDenialReason.InvalidIntent,
      }),
    )
  }
  const intent = decoded.success
  if (intent.accountId !== expectedAccountId) {
    return Result.fail(
      invalidRequest({
        operation: MutationOperation.Submit,
        message: 'order intent account does not match the configured Alpaca account',
        denialReason: SubmissionDenialReason.AccountMismatch,
      }),
    )
  }
  const body = submitBody(intent)
  if (Result.isFailure(body)) {
    return Result.fail(
      invalidRequest({
        operation: MutationOperation.Submit,
        message: 'order intent cannot be submitted',
        denialReason: SubmissionDenialReason.OrderContract,
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
  if (Result.isSuccess(decoded)) {
    const canonical = canonicalHashV1Result(decoded.success)
    if (Result.isSuccess(canonical)) return Result.succeed(canonical.success)
  }
  return Result.mapError(canonicalHashV1Result(facts.body), (cause) =>
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
  const expectedLimitPriceMicros =
    'limit_price' in facts.request ? decimalToMicros(facts.request.limit_price) : undefined
  const commonMatches =
    order.accountId === facts.intent.accountId &&
    order.assetClass ===
      (instrumentMarket(facts.intent.symbol) === MarketKind.Crypto ? AssetClass.Crypto : AssetClass.UsEquity) &&
    order.clientOrderId === facts.intent.clientOrderId &&
    order.symbol === facts.intent.symbol &&
    order.side === facts.request.side &&
    order.orderType === facts.request.type &&
    order.timeInForce === facts.request.time_in_force &&
    order.limitPriceMicros === expectedLimitPriceMicros &&
    order.extendedHours === facts.request.extended_hours &&
    order.stopPriceMicros ===
      (facts.request.stop_price === undefined ? undefined : decimalToMicros(facts.request.stop_price)) &&
    order.orderClass === (facts.request.order_class ?? 'simple')
  if (!commonMatches) return false
  if (facts.intent.protection?._tag === 'Bracket' || facts.intent.protection?._tag === 'Oco') {
    if (
      Result.isFailure(
        verifyProtectionGroup(order, {
          symbol: facts.intent.symbol,
          quantityAtoms: facts.intent.quantityAtoms,
          protection: facts.intent.protection,
        }),
      )
    )
      return false
  }
  return order.quantityAtoms === facts.intent.quantityAtoms && order.notionalMicros === undefined
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
