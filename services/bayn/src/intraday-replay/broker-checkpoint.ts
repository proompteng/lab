import { Data, Result, Schema } from 'effect'
import {
  AssetClass,
  OrderClass,
  OrderSide,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradeActivityType,
} from '../broker/alpaca/model'
import { canonicalHashV1Result } from '../hash'
import { limitIocOrderRequestBody } from '../broker/alpaca-mutations/decisions'
import {
  OrderSide as DomainSide,
  OrderType as DomainOrderType,
  TimeInForce as DomainTimeInForce,
} from '../execution/contracts'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  PositiveMicrosSchema,
  Sha256Schema,
  SignedMicrosSchema,
  StrictNonEmptyStringSchema,
  SymbolSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { applyReplayFill, createReplayLedger } from './ledger'
import type { ReplayBrokerConfig, ReplayBrokerFill, ReplayBrokerState } from './broker'

const OrderSchema = Schema.Struct({
  accountId: StrictNonEmptyStringSchema,
  brokerOrderId: StrictNonEmptyStringSchema,
  clientOrderId: StrictNonEmptyStringSchema,
  createdAt: UtcInstantSchema,
  updatedAt: UtcInstantSchema,
  submittedAt: UtcInstantSchema,
  filledAt: Schema.optionalKey(UtcInstantSchema),
  canceledAt: Schema.optionalKey(UtcInstantSchema),
  failedAt: Schema.optionalKey(UtcInstantSchema),
  assetId: StrictNonEmptyStringSchema,
  symbol: SymbolSchema,
  assetClass: Schema.Literal(AssetClass.UsEquity),
  quantityMicros: PositiveMicrosSchema,
  filledQuantityMicros: UnsignedMicrosSchema,
  filledAveragePriceMicros: Schema.optionalKey(PositiveMicrosSchema),
  orderClass: Schema.Literal(OrderClass.Simple),
  orderType: Schema.Literal(OrderType.Limit),
  side: Schema.Enum(OrderSide),
  timeInForce: Schema.Literal(TimeInForce.ImmediateOrCancel),
  limitPriceMicros: PositiveMicrosSchema,
  status: Schema.Literals([OrderStatus.Filled, OrderStatus.Canceled, OrderStatus.Rejected]),
  extendedHours: Schema.Literal(false),
  observedAt: UtcInstantSchema,
})
const EconomicFillSchema = Schema.Struct({
  symbol: SymbolSchema,
  side: Schema.Enum(OrderSide),
  observedAt: UtcInstantSchema,
  quantityMicros: PositiveMicrosSchema,
  priceMicros: PositiveMicrosSchema,
  notionalMicros: PositiveMicrosSchema,
  brokerOrderId: StrictNonEmptyStringSchema,
  clientOrderId: StrictNonEmptyStringSchema,
  quoteSource: Schema.Struct({
    topic: StrictNonEmptyStringSchema,
    partition: NonNegativeIntegerSchema,
    offset: UnsignedMicrosSchema,
    availableAtMs: NonNegativeIntegerSchema,
  }),
})
export const ReplayBrokerCheckpointSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.simulated-broker-checkpoint.v1'),
  configurationHash: Sha256Schema,
  sourceManifestHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  state: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.simulated-broker-state.v1'),
    runId: Sha256Schema,
    accountId: StrictNonEmptyStringSchema,
    ledger: Schema.Struct({
      openingCashMicros: PositiveMicrosSchema,
      cashMicros: UnsignedMicrosSchema,
      executionFeesMicros: UnsignedMicrosSchema,
      positions: Schema.Array(
        Schema.Struct({
          symbol: SymbolSchema,
          quantityMicros: PositiveMicrosSchema,
          costBasisMicros: PositiveMicrosSchema,
        }),
      ),
      fills: Schema.Array(EconomicFillSchema),
      netRealizedPnlAfterCostsMicros: Schema.NullOr(SignedMicrosSchema),
    }),
    orders: Schema.Array(
      Schema.Struct({
        requestHash: Sha256Schema,
        order: OrderSchema,
        deliveryFailure: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      }),
    ),
    fills: Schema.Array(
      Schema.Struct({
        accountId: StrictNonEmptyStringSchema,
        activityId: StrictNonEmptyStringSchema,
        cumulativeQuantityMicros: PositiveMicrosSchema,
        leavesQuantityMicros: UnsignedMicrosSchema,
        priceMicros: PositiveMicrosSchema,
        quantityMicros: PositiveMicrosSchema,
        side: Schema.Enum(OrderSide),
        symbol: SymbolSchema,
        transactionTime: UtcInstantSchema,
        brokerOrderId: StrictNonEmptyStringSchema,
        type: Schema.Enum(TradeActivityType),
        orderStatus: Schema.Enum(OrderStatus),
      }),
    ),
    fees: Schema.Array(
      Schema.Struct({
        accountId: StrictNonEmptyStringSchema,
        activityId: StrictNonEmptyStringSchema,
        date: IsoDateSchema,
        netAmountMicros: SignedMicrosSchema,
      }),
    ),
    sessionCloses: Schema.Array(Schema.Struct({ sessionDate: IsoDateSchema, equityMicros: UnsignedMicrosSchema })),
  }),
  checkpointHash: Sha256Schema,
})
export type ReplayBrokerCheckpoint = typeof ReplayBrokerCheckpointSchema.Type
export class ReplayCheckpointFailure extends Data.TaggedError('ReplayCheckpointFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}
const fail = (message: string) => Result.fail(new ReplayCheckpointFailure({ message }))
export const replayBrokerConfigurationHash = (config: ReplayBrokerConfig) =>
  canonicalHashV1Result({
    runId: config.runId,
    sourceManifestHash: config.sourceManifestHash,
    openingCashMicros: config.openingCashMicros,
    protocol: config.protocol,
    assumptions: config.assumptions,
    fractionalTrading: config.fractionalTrading,
    assets: config.assets,
    calendar: config.calendar,
  })

/** Recompute exact economics and activities before any restored state can answer a production broker read. */
export const restoreReplayBrokerCheckpoint = (input: unknown, config: ReplayBrokerConfig) =>
  Result.gen(function* () {
    const decoded = yield* Schema.decodeUnknownResult(ReplayBrokerCheckpointSchema, strictParseOptions)(input)
    const { checkpointHash, ...material } = decoded
    if (
      (yield* canonicalHashV1Result(material)) !== checkpointHash ||
      decoded.configurationHash !== (yield* replayBrokerConfigurationHash(config)) ||
      decoded.sourceManifestHash !== config.sourceManifestHash ||
      decoded.state.runId !== config.runId ||
      decoded.state.accountId !== `replay-${config.runId}`
    )
      return yield* fail('Broker checkpoint hash, source or configuration does not match this run')
    const state = decoded.state
    const orderIds = new Set<string>(),
      clientIds = new Set<string>()
    for (const { order, requestHash } of state.orders) {
      const digest = yield* canonicalHashV1Result({ runId: config.runId, clientOrderId: order.clientOrderId })
      const expectedId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
      if (
        orderIds.has(order.brokerOrderId) ||
        clientIds.has(order.clientOrderId) ||
        order.brokerOrderId !== expectedId ||
        order.accountId !== state.accountId ||
        order.observedAt > decoded.observedAt ||
        order.createdAt > order.observedAt ||
        config.assets.find((asset) => asset.symbol === order.symbol)?.assetId !== order.assetId ||
        BigInt(order.filledQuantityMicros) > BigInt(order.quantityMicros)
      )
        return yield* fail('Broker checkpoint order identity, time or quantity is invalid')
      const body = yield* limitIocOrderRequestBody({
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side === OrderSide.Buy ? DomainSide.Buy : DomainSide.Sell,
        orderType: DomainOrderType.Limit,
        timeInForce: DomainTimeInForce.ImmediateOrCancel,
        quantityMicros: order.quantityMicros,
        notionalLimitMicros: ((BigInt(order.limitPriceMicros) * BigInt(order.quantityMicros)) / 1000000n).toString(),
      })
      if (
        requestHash !== (yield* canonicalHashV1Result(body)) ||
        (order.status === OrderStatus.Filled && order.filledQuantityMicros !== order.quantityMicros) ||
        (order.status === OrderStatus.Rejected &&
          (order.filledQuantityMicros !== '0' || order.failedAt === undefined)) ||
        (order.status === OrderStatus.Canceled &&
          (order.canceledAt === undefined || order.filledQuantityMicros === order.quantityMicros)) ||
        [order.updatedAt, order.submittedAt, order.filledAt, order.canceledAt, order.failedAt].some(
          (at) => at !== undefined && (at < order.createdAt || at > decoded.observedAt),
        )
      )
        return yield* fail('Broker checkpoint request or terminal status is inconsistent')
      orderIds.add(order.brokerOrderId)
      clientIds.add(order.clientOrderId)
    }
    let ledger = yield* createReplayLedger<ReplayBrokerFill>(config.openingCashMicros)
    const expectedFills: (typeof state.fills)[number][] = []
    const expectedFees: (typeof state.fees)[number][] = []
    const filledIds = new Set<string>()
    let previousFillAt = ''
    for (const fill of state.ledger.fills) {
      const order = state.orders.find((entry) => entry.order.brokerOrderId === fill.brokerOrderId)?.order
      if (
        order === undefined ||
        filledIds.has(fill.brokerOrderId) ||
        fill.clientOrderId !== order.clientOrderId ||
        fill.symbol !== order.symbol ||
        fill.side !== order.side ||
        fill.quantityMicros !== order.filledQuantityMicros ||
        fill.priceMicros !== order.filledAveragePriceMicros ||
        fill.observedAt !== order.filledAt ||
        fill.observedAt < order.createdAt ||
        fill.observedAt < previousFillAt ||
        fill.observedAt > decoded.observedAt ||
        fill.quoteSource.availableAtMs > Date.parse(fill.observedAt)
      )
        return yield* fail('Broker checkpoint fill is not bound to its order and arrival')
      const next = yield* applyReplayFill(
        ledger,
        fill,
        order.quantityMicros,
        config.protocol.executionModel,
        config.assumptions.feeMultiplierPpm,
      )
      const fee = BigInt(next.executionFeesMicros) - BigInt(ledger.executionFeesMicros)
      if (fee !== 0n)
        expectedFees.push({
          accountId: state.accountId,
          activityId: `fee::${fill.brokerOrderId}`,
          date: yield* Schema.decodeUnknownResult(IsoDateSchema)(fill.observedAt.slice(0, 10)),
          netAmountMicros: (-fee).toString(),
        })
      expectedFills.push({
        accountId: state.accountId,
        activityId: `fill::${fill.brokerOrderId}`,
        cumulativeQuantityMicros: fill.quantityMicros,
        leavesQuantityMicros: (BigInt(order.quantityMicros) - BigInt(fill.quantityMicros)).toString(),
        priceMicros: fill.priceMicros,
        quantityMicros: fill.quantityMicros,
        side: fill.side,
        symbol: fill.symbol,
        transactionTime: fill.observedAt,
        brokerOrderId: fill.brokerOrderId,
        type: order.status === OrderStatus.Filled ? TradeActivityType.Fill : TradeActivityType.PartialFill,
        orderStatus: order.status,
      })
      filledIds.add(fill.brokerOrderId)
      previousFillAt = fill.observedAt
      ledger = next
    }
    if (
      state.orders.some(
        ({ order }) => BigInt(order.filledQuantityMicros) > 0n !== filledIds.has(order.brokerOrderId),
      ) ||
      (yield* canonicalHashV1Result(ledger)) !== (yield* canonicalHashV1Result(state.ledger)) ||
      (yield* canonicalHashV1Result(expectedFills)) !== (yield* canonicalHashV1Result(state.fills)) ||
      (yield* canonicalHashV1Result(expectedFees)) !== (yield* canonicalHashV1Result(state.fees))
    )
      return yield* fail('Broker checkpoint cash, positions, fees or activities do not reconstruct exactly')
    const dates = state.sessionCloses.map((close) => close.sessionDate)
    if (
      new Set(dates).size !== dates.length ||
      dates.some(
        (date, index) =>
          date > decoded.observedAt.slice(0, 10) ||
          (index > 0 && date <= (dates[index - 1] ?? '')) ||
          !config.calendar.some((session) => session.date === date),
      )
    )
      return yield* fail('Broker checkpoint session closes are duplicated or outside its calendar')
    for (const close of state.sessionCloses) {
      const calendar = yield* normalizeMarketCalendarResult(
        config.calendar.filter((session) => session.date === close.sessionDate),
        { start: close.sessionDate, end: close.sessionDate },
      )
      const session = calendar.sessions[0]
      if (session === undefined || session.closeAt > decoded.observedAt)
        return yield* fail('Broker checkpoint records a close before market close')
    }
    return decoded
  }).pipe(
    Result.mapError((cause) => new ReplayCheckpointFailure({ message: 'Broker checkpoint validation failed', cause })),
  )

export const makeReplayBrokerCheckpoint = (config: ReplayBrokerConfig, state: ReplayBrokerState, observedAt: string) =>
  Result.gen(function* () {
    const material = {
      schemaVersion: 'bayn.simulated-broker-checkpoint.v1' as const,
      configurationHash: yield* replayBrokerConfigurationHash(config),
      sourceManifestHash: config.sourceManifestHash,
      observedAt,
      state,
    }
    return yield* restoreReplayBrokerCheckpoint(
      { ...material, checkpointHash: yield* canonicalHashV1Result(material) },
      config,
    )
  })
