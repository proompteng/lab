import { ObservedFeeActivitySchema } from '../broker/fee-activity'
import { NativeProtectionSchema } from '../execution/contracts'
import { verifyProtectionGroup } from '../broker/alpaca/protection-group'
import { replayFeeActivity } from './broker-fees'
import { cryptoTakerFeeSchedule } from '../strategy/execution-model/fees'
import { InstrumentSymbolSchema } from '../instruments'
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
import { orderRequestBody } from '../broker/alpaca-mutations/decisions'
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
  UnsignedMicrosSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../schemas'
import { applyReplayFill, createReplayLedger } from './ledger'
import { ReplayOrderExecutionSchema } from './broker-execution-evidence'
import type { ReplayBrokerConfig, ReplayBrokerFill, ReplayBrokerState, ReplayOrder } from './broker'

const OrderFields = {
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
  symbol: InstrumentSymbolSchema,
  assetClass: Schema.Literals([AssetClass.UsEquity, AssetClass.Crypto]),
  quantityAtoms: PositiveMicrosSchema,
  filledQuantityAtoms: UnsignedMicrosSchema,
  filledAveragePriceMicros: Schema.optionalKey(PositiveMicrosSchema),
  orderClass: Schema.Literals([OrderClass.Simple, OrderClass.Bracket, OrderClass.OneCancelsOther]),
  status: Schema.Literals([
    OrderStatus.New,
    OrderStatus.Held,
    OrderStatus.PartiallyFilled,
    OrderStatus.Filled,
    OrderStatus.Canceled,
    OrderStatus.Expired,
    OrderStatus.Rejected,
  ]),
  extendedHours: Schema.Boolean,
  observedAt: UtcInstantSchema,
  parentBrokerOrderId: Schema.optionalKey(StrictNonEmptyStringSchema),
  nativeProtection: Schema.optionalKey(NativeProtectionSchema),
  firstArrivedAt: Schema.optionalKey(UtcInstantSchema),
  stopTriggeredAt: Schema.optionalKey(UtcInstantSchema),
}
const OrderSchema = Schema.Struct({
  ...OrderFields,
  side: Schema.Enum(OrderSide),
  orderType: Schema.Literals([OrderType.Limit, OrderType.StopLimit]),
  timeInForce: Schema.Literals([TimeInForce.Day, TimeInForce.ImmediateOrCancel, TimeInForce.GoodUntilCanceled]),
  limitPriceMicros: PositiveMicrosSchema,
  stopPriceMicros: Schema.optionalKey(PositiveMicrosSchema),
})
const EconomicFillSchema = Schema.Struct({
  executionIndex: NonNegativeIntegerSchema,
  symbol: InstrumentSymbolSchema,
  side: Schema.Enum(OrderSide),
  observedAt: UtcInstantSchema,
  quantityAtoms: PositiveMicrosSchema,
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
  schemaVersion: Schema.Literal('bayn.simulated-broker-checkpoint.v10'),
  configurationHash: Sha256Schema,
  sourceManifestHash: Sha256Schema,
  observedAt: UtcInstantSchema,
  state: Schema.Struct({
    schemaVersion: Schema.Literal('bayn.simulated-broker-state.v7'),
    createdAt: UtcInstantSchema,
    runId: Sha256Schema,
    accountId: StrictNonEmptyStringSchema,
    ledger: Schema.Struct({
      openingCashMicros: PositiveMicrosSchema,
      cashMicros: UnsignedMicrosSchema,
      executionFeesMicros: UnsignedMicrosSchema,
      positions: Schema.Array(
        Schema.Struct({
          symbol: InstrumentSymbolSchema,
          quantityAtoms: PositiveMicrosSchema,
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
        executions: Schema.Array(ReplayOrderExecutionSchema),
      }),
    ),
    fills: Schema.Array(
      Schema.Struct({
        accountId: StrictNonEmptyStringSchema,
        activityId: StrictNonEmptyStringSchema,
        cumulativeQuantityAtoms: PositiveMicrosSchema,
        leavesQuantityAtoms: UnsignedMicrosSchema,
        priceAtoms: PositiveMicrosSchema,
        quantityAtoms: PositiveMicrosSchema,
        side: Schema.Enum(OrderSide),
        symbol: InstrumentSymbolSchema,
        transactionTime: UtcInstantSchema,
        brokerOrderId: StrictNonEmptyStringSchema,
        type: Schema.Enum(TradeActivityType),
        orderStatus: Schema.Enum(OrderStatus),
      }),
    ),
    fees: Schema.Array(ObservedFeeActivitySchema),
    sessionCloses: Schema.Array(
      Schema.Struct({
        sessionDate: IsoDateSchema,
        equityMicros: UnsignedMicrosSchema,
        valuationQualified: Schema.Boolean,
      }),
    ),
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
    cryptoFeeSchedule: cryptoTakerFeeSchedule,
    fractionalTrading: config.fractionalTrading,
    assets: config.assets,
    calendar: config.calendar,
  })

export const replayQuantityAtFill = (state: ReplayBrokerState, order: ReplayOrder, index: number): bigint => {
  const parent = state.orders.find((entry) => entry.order.brokerOrderId === order.parentBrokerOrderId)?.order
  if (parent === undefined || order.orderType !== OrderType.StopLimit) return BigInt(order.quantityAtoms)
  const profitId =
    parent.nativeProtection?._tag === 'Oco'
      ? parent.brokerOrderId
      : state.orders.find(
          (entry) =>
            entry.order.parentBrokerOrderId === parent.brokerOrderId && entry.order.orderType === OrderType.Limit,
        )?.order.brokerOrderId
  const disposed = state.ledger.fills
    .slice(0, index)
    .filter((fill) => fill.brokerOrderId === profitId)
    .reduce((sum, fill) => sum + BigInt(fill.quantityAtoms), 0n)
  return BigInt(parent.quantityAtoms) - disposed
}

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
    if (
      state.createdAt > decoded.observedAt ||
      state.orders.some(({ order }) => order.submittedAt < state.createdAt) ||
      state.ledger.fills.some((fill) => fill.observedAt < state.createdAt)
    )
      return yield* fail('Broker checkpoint account inception does not bound its activity and observation')
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
        order.assetClass !== config.assets.find((asset) => asset.symbol === order.symbol)?.assetClass ||
        BigInt(order.filledQuantityAtoms) > BigInt(order.quantityAtoms)
      )
        return yield* fail('Broker checkpoint order identity, time or quantity is invalid')
      const common = {
        clientOrderId: order.clientOrderId,
        symbol: order.symbol,
        side: order.side === OrderSide.Buy ? DomainSide.Buy : DomainSide.Sell,
        quantityAtoms: order.quantityAtoms,
      }
      const parent = state.orders.find((entry) => entry.order.brokerOrderId === order.parentBrokerOrderId)
      const root = parent?.order ?? order
      const terms = root.nativeProtection
      if (
        parent !== undefined &&
        (terms === undefined || terms._tag === 'StopLimit' || requestHash !== parent.requestHash)
      )
        return yield* fail('Generated protection child has no matching submitted parent')
      if (order.parentBrokerOrderId !== undefined && parent === undefined)
        return yield* fail('Generated protection child references an absent parent')
      const body =
        parent !== undefined
          ? null
          : yield* orderRequestBody({
              ...common,
              orderType: order.orderType === OrderType.StopLimit ? DomainOrderType.StopLimit : DomainOrderType.Limit,
              timeInForce:
                order.timeInForce === TimeInForce.Day
                  ? DomainTimeInForce.Day
                  : order.timeInForce === TimeInForce.GoodUntilCanceled
                    ? DomainTimeInForce.GoodUntilCanceled
                    : DomainTimeInForce.ImmediateOrCancel,
              ...(order.nativeProtection === undefined ? {} : { protection: order.nativeProtection }),
              limitPriceMicros: order.limitPriceMicros,
              notionalLimitMicros: (
                (BigInt(order.limitPriceMicros) * BigInt(order.quantityAtoms) +
                  (order.side === OrderSide.Buy ? 999999999n : 0n)) /
                1000000000n
              ).toString(),
            })
      if (
        (body !== null &&
          (requestHash !== (yield* canonicalHashV1Result(body)) || order.extendedHours !== body.extended_hours)) ||
        (order.status === OrderStatus.Filled && order.filledQuantityAtoms !== order.quantityAtoms) ||
        (order.status === OrderStatus.Rejected && order.failedAt === undefined) ||
        ([OrderStatus.Canceled, OrderStatus.Expired].includes(order.status) &&
          ((order.status === OrderStatus.Canceled && order.canceledAt === undefined) ||
            order.filledQuantityAtoms === order.quantityAtoms)) ||
        [order.updatedAt, order.submittedAt, order.filledAt, order.canceledAt, order.failedAt].some(
          (at) => at !== undefined && (at < order.createdAt || at > decoded.observedAt),
        )
      )
        return yield* fail('Broker checkpoint request or terminal status is inconsistent')
      if (terms !== undefined && terms._tag !== 'StopLimit' && parent === undefined) {
        const legs = state.orders
          .filter((entry) => entry.order.parentBrokerOrderId === order.brokerOrderId)
          .map((entry) => entry.order)
        if (
          Result.isFailure(
            verifyProtectionGroup(
              { ...order, legs },
              { symbol: order.symbol, quantityAtoms: order.quantityAtoms, protection: terms },
            ),
          )
        )
          return yield* fail('Broker checkpoint protection group differs from submitted strategy terms')
      }
      if (
        order.orderType === OrderType.StopLimit &&
        (order.stopPriceMicros === undefined ||
          (order.stopTriggeredAt !== undefined &&
            (order.stopTriggeredAt < order.createdAt ||
              order.stopTriggeredAt > order.updatedAt ||
              state.orders
                .find((entry) => entry.order.brokerOrderId === order.brokerOrderId)
                ?.executions.some(
                  (execution) =>
                    execution.arrivedAt === order.stopTriggeredAt &&
                    execution.quote !== null &&
                    Math.round(execution.quote.bidPrice * 1_000_000) <= Number(order.stopPriceMicros),
                ) !== true)))
      )
        return yield* fail('Broker checkpoint stop trigger lacks its executable quote')
      const record = state.orders.find((entry) => entry.order.brokerOrderId === order.brokerOrderId)
      if (
        ([OrderStatus.New, OrderStatus.PartiallyFilled, OrderStatus.Filled].includes(order.status) ||
          (record?.executions.length ?? 0) > 0) &&
        order.firstArrivedAt === undefined
      )
        return yield* fail('A working or executed order requires its retained broker arrival')
      if (
        order.firstArrivedAt !== undefined &&
        (Date.parse(order.firstArrivedAt) < Date.parse(order.submittedAt) + config.assumptions.latencyMs ||
          order.firstArrivedAt > order.updatedAt ||
          (order.stopTriggeredAt !== undefined && order.stopTriggeredAt < order.firstArrivedAt) ||
          record?.executions.some((execution) => execution.arrivedAt < (order.firstArrivedAt ?? '')) === true)
      )
        return yield* fail('Broker arrival must precede every order execution and follow routing latency')
      orderIds.add(order.brokerOrderId)
      clientIds.add(order.clientOrderId)
    }
    let ledger = yield* createReplayLedger<ReplayBrokerFill>(config.openingCashMicros)
    const expectedFills: (typeof state.fills)[number][] = []
    const expectedFees: (typeof state.fees)[number][] = []
    const filledOrders = new Map<
      string,
      { quantity: bigint; notional: bigint; lastFillAt: string; indices: Set<number> }
    >()
    let previousFillAt = ''
    for (const fill of state.ledger.fills) {
      const record = state.orders.find((entry) => entry.order.brokerOrderId === fill.brokerOrderId)
      const order = record?.order
      const prior = filledOrders.get(fill.brokerOrderId)
      const execution = record?.executions[fill.executionIndex - 1]
      if (
        order === undefined ||
        fill.executionIndex <= 0 ||
        prior?.indices.has(fill.executionIndex) === true ||
        execution?.outcome.status !== 'filled' ||
        execution.outcome.filledQuantityAtoms !== fill.quantityAtoms ||
        execution.outcome.fillPriceMicros !== fill.priceMicros ||
        execution.outcome.fillNotionalMicros !== fill.notionalMicros ||
        execution.arrivedAt !== fill.observedAt ||
        fill.clientOrderId !== order.clientOrderId ||
        fill.symbol !== order.symbol ||
        fill.side !== order.side ||
        fill.observedAt < order.createdAt ||
        fill.observedAt < previousFillAt ||
        fill.observedAt > decoded.observedAt ||
        fill.quoteSource.availableAtMs > Date.parse(fill.observedAt)
      )
        return yield* fail('Broker checkpoint fill is not bound to its order and quote evaluation')
      const quantityAtFill = replayQuantityAtFill(state, order, state.ledger.fills.indexOf(fill))
      const totalQuantity = (prior?.quantity ?? 0n) + BigInt(fill.quantityAtoms)
      const totalNotional = (prior?.notional ?? 0n) + BigInt(fill.notionalMicros)
      const next = yield* applyReplayFill(
        ledger,
        fill,
        (quantityAtFill - (prior?.quantity ?? 0n)).toString(),
        config.protocol.executionModel,
        config.assumptions.feeMultiplierPpm,
      )
      const fee = replayFeeActivity(
        state.accountId,
        fill,
        ledger.executionFeesMicros,
        next.executionFeesMicros,
        config.assumptions.feeMultiplierPpm,
      )
      if (fee !== null) expectedFees.push({ ...fee, date: yield* Schema.decodeUnknownResult(IsoDateSchema)(fee.date) })
      const complete = totalQuantity === quantityAtFill
      expectedFills.push({
        accountId: state.accountId,
        activityId: `fill::${String(expectedFills.length).padStart(16, '0')}::${fill.brokerOrderId}::${fill.executionIndex}`,
        cumulativeQuantityAtoms: totalQuantity.toString(),
        leavesQuantityAtoms: (quantityAtFill - totalQuantity).toString(),
        priceAtoms: (BigInt(fill.priceMicros) * 1000n).toString(),
        quantityAtoms: fill.quantityAtoms,
        side: fill.side,
        symbol: fill.symbol,
        transactionTime: fill.observedAt,
        brokerOrderId: fill.brokerOrderId,
        type: complete ? TradeActivityType.Fill : TradeActivityType.PartialFill,
        orderStatus: complete
          ? OrderStatus.Filled
          : order.timeInForce !== TimeInForce.ImmediateOrCancel
            ? OrderStatus.PartiallyFilled
            : OrderStatus.Canceled,
      })
      filledOrders.set(fill.brokerOrderId, {
        quantity: totalQuantity,
        notional: totalNotional,
        lastFillAt: fill.observedAt,
        indices: new Set([...(prior?.indices ?? []), fill.executionIndex]),
      })
      previousFillAt = fill.observedAt
      ledger = next
    }
    for (const { order, executions } of state.orders) {
      const fills = filledOrders.get(order.brokerOrderId)
      if (
        BigInt(order.filledQuantityAtoms) !== (fills?.quantity ?? 0n) ||
        (fills !== undefined &&
          (order.filledAt !== fills.lastFillAt ||
            order.filledAveragePriceMicros !==
              ((fills.notional * 1_000_000_000n + fills.quantity / 2n) / fills.quantity).toString())) ||
        (order.status === OrderStatus.New &&
          (order.filledQuantityAtoms !== '0' ||
            (executions.length === 0 &&
              order.parentBrokerOrderId === undefined &&
              order.orderType !== OrderType.StopLimit))) ||
        (order.status === OrderStatus.PartiallyFilled &&
          (fills === undefined || fills.quantity >= BigInt(order.quantityAtoms))) ||
        executions.some(
          (execution, index) =>
            execution.submittedAt !== order.submittedAt ||
            execution.arrivedAt < order.submittedAt ||
            execution.arrivedAt > order.updatedAt ||
            (index > 0 && execution.arrivedAt < (executions[index - 1]?.arrivedAt ?? '')) ||
            (execution.outcome.status === 'filled' && fills?.indices.has(index + 1) !== true),
        )
      )
        return yield* fail('Broker checkpoint order status or execution history does not reconstruct exactly')
    }
    if (
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
      const session = calendar.providerSessions[0]
      if (
        session === undefined ||
        session.regularCloseAt > decoded.observedAt ||
        session.regularCloseAt < state.createdAt
      )
        return yield* fail('Broker checkpoint records a close before market close')
    }
    return decoded
  }).pipe(
    Result.mapError((cause) => new ReplayCheckpointFailure({ message: 'Broker checkpoint validation failed', cause })),
  )

export const makeReplayBrokerCheckpoint = (config: ReplayBrokerConfig, state: ReplayBrokerState, observedAt: string) =>
  Result.gen(function* () {
    const material = {
      schemaVersion: 'bayn.simulated-broker-checkpoint.v10' as const,
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
