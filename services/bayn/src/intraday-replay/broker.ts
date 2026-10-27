import { replayFeeActivity } from './broker-fees'
import { instrumentMarket, instrumentQuantityTerms, MarketKind } from '../instruments'
import { jevMarketForSymbol } from '../jev/markets'
import { readStableBrokerSnapshot } from '../simulation-reconciliation/broker-history'
import { Cause, Clock, Data, Effect, Exit, Fiber, Ref, Result, Schema, SynchronizedRef } from 'effect'

import {
  AccountStatus,
  AssetClass,
  OrderClass,
  OrderSide,
  OrderCollection,
  OrderStatus,
  OrderType,
  PositionSide,
  TimeInForce,
  TradeActivityType,
  MarketCalendarResponseSchema,
  MarketCalendarQueryBase,
  type Account,
  type AssetObservation,
  type BrokerReadShape,
  type FeeActivity,
  type FillActivity,
  type Order,
  type Position,
  type ReadResult,
} from '../broker/alpaca/model'
import { BrokerReadError, BrokerReadErrorKind } from '../broker/alpaca/failures'
import {
  decimalToMicrosResult,
  normalizeAccountConfigurationResult,
  normalizeMarketCalendarResult,
} from '../broker/alpaca/normalizers'
import {
  orderRequestRequiresFractionalTrading,
  prepareCancel,
  classifyCancelResponse,
  prepareSubmit,
} from '../broker/alpaca-mutations/decisions'
import {
  BrokerMutationError,
  MutationFailure,
  MutationOperation,
  type BrokerMutationShape,
  causeSummary,
} from '../broker/alpaca-mutations/model'
import { MutationOutcome, OrderSide as IntentSide, type Intent, type NativeProtection } from '../execution/contracts'
import { quantityFromNumber } from '../quantity'
import { numberToMicros, notionalMicros } from '../strategy/execution-model/fixed-point'
import { MICROS } from '../strategy/execution-model/model'
import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, UtcInstantSchema, strictParseOptions } from '../schemas'
import type { IntradayQuote } from '../market-data/intraday/model'
import type { ObservedMarketValue, ObservedQuoteSource } from '../market-data/streaming/projection'
import type { ExecutionModelV6Schema } from '../execution-model-contract'
import type { ReplayQuoteProtocol } from './broker-execution-evidence'
import { applyReplayFill, createReplayLedger, type EconomicReplayFill, type ReplayLedger } from './ledger'
import { simulateIntradayReplayExecution, type ReplayExecutionOutcome } from './execution-core'
import {
  makeReplayOrderExecution,
  replayQuoteRejection,
  ReplayQuoteRejection,
  type ReplayOrderExecution,
} from './broker-execution-evidence'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { utcInstantFromEpochMillis } from '../time'
import type { ReplayExecutionAssumptions } from './execution-core'
import {
  makeReplayBrokerCheckpoint,
  replayQuantityAtFill,
  restoreReplayBrokerCheckpoint,
  type ReplayBrokerCheckpoint,
} from './broker-checkpoint'

export class ReplayBrokerFailure extends Data.TaggedError('ReplayBrokerFailure')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export interface ReplayBrokerConfig {
  readonly runId: string
  readonly sourceManifestHash: string
  /** expectedHash comes from the independent durable store, never from the supplied value. */
  readonly restoreCheckpoint?: { readonly value: unknown; readonly expectedHash: string }
  /** Commit terminal broker state before publishing it to readers or returning a response. */
  readonly retainSettlement?: (checkpoint: ReplayBrokerCheckpoint) => Effect.Effect<void, ReplayBrokerFailure>
  readonly openingCashMicros: string
  readonly protocol: ReplayQuoteProtocol & { readonly executionModel: typeof ExecutionModelV6Schema.Type }
  readonly assumptions: ReplayExecutionAssumptions & { readonly latencyMs: number; readonly feeMultiplierPpm: number }
  readonly fractionalTrading: boolean
  readonly assets: readonly AssetObservation[]
  readonly calendar: typeof MarketCalendarResponseSchema.Type
  /** Use the same measured clock as final authorization before fixing submission and arrival timestamps. */
  readonly submissionTime?: Effect.Effect<string, ReplayBrokerFailure>
  /** A historical runner advances retained arrivals and both clocks to this exact delivery instant. */
  readonly advanceToArrival?: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>
  readonly quoteAt: (
    symbol: string,
    nowMs: number,
    source: ObservedQuoteSource | null,
  ) => Effect.Effect<ObservedMarketValue<IntradayQuote> | undefined, ReplayBrokerFailure>
}

export interface ReplayBrokerFill extends EconomicReplayFill {
  readonly executionIndex: number
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly quoteSource: ObservedQuoteSource
}

export type ReplayOrder = Order & {
  readonly orderType: OrderType.Limit | OrderType.StopLimit
  readonly timeInForce: TimeInForce.Day | TimeInForce.ImmediateOrCancel | TimeInForce.GoodUntilCanceled
  readonly limitPriceMicros: string
  readonly quantityAtoms: string
  readonly submittedAt: string
  readonly updatedAt: string
  readonly nativeProtection?: NativeProtection
  readonly firstArrivedAt?: string
  readonly stopTriggeredAt?: string
}

export interface ReplayBrokerOrder {
  readonly executions: readonly ReplayOrderExecution[]
  readonly deliveryFailure?: Readonly<Record<string, string>>
  readonly requestHash: string
  readonly order: ReplayOrder
}
export interface ReplayBrokerState {
  readonly schemaVersion: 'bayn.simulated-broker-state.v7'
  readonly createdAt: string
  readonly runId: string
  readonly accountId: string
  readonly ledger: ReplayLedger<ReplayBrokerFill>
  readonly orders: readonly ReplayBrokerOrder[]
  readonly fills: readonly FillActivity[]
  readonly fees: readonly FeeActivity[]
  readonly sessionCloses: readonly {
    readonly sessionDate: string
    readonly equityMicros: string
    readonly valuationQualified: boolean
  }[]
}

export interface ReplayValuationEvidence {
  readonly model: 'last-observed-bid'
  readonly observedAt: string
  readonly marks: readonly {
    readonly symbol: string
    readonly priceMicros: string
    readonly eventAt: string
    readonly availableAtMs: number
    readonly ageNanos: string
    readonly staleForExecution: boolean
    readonly bidLiquidityAvailable: boolean
    readonly topic: string
    readonly partition: number
    readonly offset: string
    readonly recordHash: string
  }[]
}

const readFailure = (operation: BrokerReadError['operation'], message: string, cause?: unknown) =>
  new BrokerReadError({ operation, kind: BrokerReadErrorKind.InvalidResponse, message, retryable: false, cause })
const mutationFailure = (operation: MutationOperation, message: string) =>
  new BrokerMutationError({ operation, failure: MutationFailure.Rejected, outcome: MutationOutcome.Known, message })
const hash = (input: unknown) =>
  canonicalHashV1Result(input).pipe(
    Result.mapError((cause) => new ReplayBrokerFailure({ message: 'Replay broker evidence cannot be hashed', cause })),
  )
const simulatedUuid = (digest: string) =>
  `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
const isOpen = (order: Order) => order.status === OrderStatus.New || order.status === OrderStatus.PartiallyFilled
const isWorking = (order: Order) => isOpen(order) || order.status === OrderStatus.Held
const publicOrder = (order: ReplayOrder, observedAt: string): Order => {
  const { nativeProtection: _terms, stopTriggeredAt: _trigger, firstArrivedAt: _arrival, ...value } = order
  return { ...value, observedAt }
}
const groupOrder = (order: ReplayOrder, orders: readonly ReplayBrokerOrder[], observedAt: string): Order => {
  const legs = orders.filter((entry) => entry.order.parentBrokerOrderId === order.brokerOrderId)
  return {
    ...publicOrder(order, observedAt),
    ...(legs.length === 0 ? {} : { legs: legs.map((entry) => publicOrder(entry.order, observedAt)) }),
  }
}
/** Sequential quote model: this deliberately does not qualify venue cancellation races. */
const reconcileProtectionGroups = (orders: readonly ReplayBrokerOrder[], at: string): readonly ReplayBrokerOrder[] => {
  let result = orders
  for (const { order: parent } of orders) {
    const terms = parent.nativeProtection
    if (terms === undefined || terms._tag === 'StopLimit') continue
    const children = result.filter((entry) => entry.order.parentBrokerOrderId === parent.brokerOrderId)
    const profit =
      terms._tag === 'Oco' ? parent : children.find((entry) => entry.order.orderType === OrderType.Limit)?.order
    const stop = children.find((entry) => entry.order.orderType === OrderType.StopLimit)?.order
    if (profit === undefined || stop === undefined) continue
    const original = BigInt(parent.quantityAtoms)
    const residual = original - BigInt(profit.filledQuantityAtoms) - BigInt(stop.filledQuantityAtoms)
    const canceled = [parent, ...children.map((entry) => entry.order)].some((order) =>
      [OrderStatus.Canceled, OrderStatus.Expired, OrderStatus.Rejected].includes(order.status),
    )
    result = result.map((entry) => {
      const order = entry.order
      if (order.brokerOrderId !== profit.brokerOrderId && order.brokerOrderId !== stop.brokerOrderId) return entry
      if (!isWorking(order)) return entry
      if (canceled || residual <= 0n)
        return {
          ...entry,
          order: { ...order, status: OrderStatus.Canceled, canceledAt: at, updatedAt: at, observedAt: at },
        }
      const active = terms._tag === 'Oco' ? parent.firstArrivedAt !== undefined : parent.status === OrderStatus.Filled
      const quantityAtoms =
        order.brokerOrderId === stop.brokerOrderId
          ? (original - BigInt(profit.filledQuantityAtoms)).toString()
          : order.quantityAtoms
      const activated = active && (order.status === OrderStatus.Held || order.firstArrivedAt === undefined)
      return {
        ...entry,
        order: {
          ...order,
          quantityAtoms,
          ...(activated ? { status: OrderStatus.New, firstArrivedAt: at } : {}),
          ...(activated || quantityAtoms !== order.quantityAtoms ? { updatedAt: at, observedAt: at } : {}),
        },
      }
    })
  }
  return result
}
const quoteLiquidityKey = (symbol: string, side: ReplayBrokerFill['side'], source: ReplayBrokerFill['quoteSource']) =>
  JSON.stringify([symbol, side, source.topic, source.partition, source.offset, source.availableAtMs])
const consumedQuoteLiquidity = (fills: ReplayBrokerState['ledger']['fills'], key: string) =>
  fills.reduce(
    (consumed, fill) =>
      quoteLiquidityKey(fill.symbol, fill.side, fill.quoteSource) === key
        ? consumed + BigInt(fill.quantityAtoms)
        : consumed,
    0n,
  )
const newYorkDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** No HTTP client or credentials are acquired. Both ports operate on the same simulated broker state. */
export const makeReplayBroker = (config: ReplayBrokerConfig) =>
  Effect.gen(function* () {
    const acquiredAtMs = yield* Clock.currentTimeMillis
    yield* Effect.fromResult(Schema.decodeUnknownResult(Sha256Schema, strictParseOptions)(config.runId))
    if (!Number.isSafeInteger(config.assumptions.latencyMs) || config.assumptions.latencyMs < 0)
      return yield* new ReplayBrokerFailure({ message: 'Replay broker latency must be a nonnegative integer' })
    if (
      !Number.isSafeInteger(config.assumptions.slippageBps) ||
      config.assumptions.slippageBps < 0 ||
      config.assumptions.slippageBps > 10_000 ||
      !Number.isSafeInteger(config.assumptions.availableLiquidityPpm) ||
      config.assumptions.availableLiquidityPpm <= 0 ||
      config.assumptions.availableLiquidityPpm > 1_000_000 ||
      !Number.isSafeInteger(config.assumptions.feeMultiplierPpm) ||
      config.assumptions.feeMultiplierPpm < 1_000_000 ||
      config.assumptions.feeMultiplierPpm > 10_000_000
    )
      return yield* new ReplayBrokerFailure({ message: 'Invalid replay execution assumptions' })
    yield* Effect.fromResult(Schema.decodeUnknownResult(Sha256Schema, strictParseOptions)(config.sourceManifestHash))
    const restored =
      config.restoreCheckpoint === undefined
        ? undefined
        : yield* Effect.fromResult(restoreReplayBrokerCheckpoint(config.restoreCheckpoint.value, config))
    if (restored !== undefined && restored.checkpointHash !== config.restoreCheckpoint?.expectedHash)
      return yield* new ReplayBrokerFailure({
        message: 'Checkpoint differs from the independently retained broker commit',
      })
    if (restored !== undefined && Date.parse(restored.observedAt) !== (yield* Clock.currentTimeMillis))
      return yield* new ReplayBrokerFailure({ message: 'Broker restore clock must equal the checkpoint observation' })
    const accountCreatedAt = restored?.state.createdAt ?? utcInstantFromEpochMillis(acquiredAtMs)
    const startedAtMs = Date.parse(accountCreatedAt)
    const brokerScope = yield* Effect.scope
    const accountId = `replay-${config.runId}`
    const ledger = yield* Effect.fromResult(createReplayLedger<ReplayBrokerFill>(config.openingCashMicros))
    const state = yield* SynchronizedRef.make<ReplayBrokerState>(
      restored?.state ?? {
        schemaVersion: 'bayn.simulated-broker-state.v7',
        createdAt: accountCreatedAt,
        runId: config.runId,
        accountId,
        ledger,
        orders: [],
        fills: [],
        fees: [],
        sessionCloses: [],
      },
    )
    const retentionFailure = yield* Ref.make<ReplayBrokerFailure | undefined>(undefined)
    const readState = Effect.gen(function* () {
      const failure = yield* Ref.get(retentionFailure)
      if (failure !== undefined) return yield* failure
      yield* expireOrders(yield* Clock.currentTimeMillis)
      return yield* SynchronizedRef.get(state)
    })
    const retainState = (next: ReplayBrokerState, observedAt: string) =>
      Effect.gen(function* () {
        const previousFailure = yield* Ref.get(retentionFailure)
        if (previousFailure !== undefined) return yield* previousFailure
        if (config.retainSettlement === undefined) return
        const checkpoint = yield* Effect.fromResult(makeReplayBrokerCheckpoint(config, next, observedAt))
        yield* config.retainSettlement(checkpoint)
      }).pipe(
        Effect.tapCause((cause) =>
          Ref.set(
            retentionFailure,
            new ReplayBrokerFailure({
              message: 'Broker settlement persistence failed; restore durable state before further reads or mutations',
              cause: Cause.squash(cause),
            }),
          ),
        ),
      )
    const updateCommittedState = (observedAt: string, update: (current: ReplayBrokerState) => ReplayBrokerState) =>
      SynchronizedRef.updateEffect(state, (current) =>
        Effect.succeed(update(current)).pipe(Effect.tap((next) => retainState(next, observedAt))),
      )
    const now = Clock.currentTimeMillis.pipe(Effect.map((value) => new Date(value).toISOString()))
    const evidence = <A>(value: A, observedAt: string): Effect.Effect<ReadResult<A>, ReplayBrokerFailure> =>
      Effect.fromResult(hash(value)).pipe(
        Effect.map((contentHash) => ({
          value,
          evidence: { requestId: `replay-${contentHash}`, status: 200, contentHash, observedAt },
        })),
      )
    const cryptoEnabled = config.assets.some((value) => value.assetClass === AssetClass.Crypto)
    const asset = (symbol: string) =>
      config.assets.find(
        (entry): entry is AssetObservation & { readonly assetClass: AssetClass.UsEquity | AssetClass.Crypto } =>
          entry.symbol === symbol &&
          entry.assetClass ===
            (instrumentMarket(symbol) === MarketKind.Crypto ? AssetClass.Crypto : AssetClass.UsEquity),
      )
    const quoteUsable = (
      quote: ObservedMarketValue<IntradayQuote> | undefined,
      symbol: string,
      nowMs: number,
    ): quote is ObservedMarketValue<IntradayQuote> =>
      replayQuoteRejection(quote, symbol, nowMs, { ...config.protocol, ...jevMarketForSymbol(symbol) }) === null
    const normalizedCalendars = yield* Effect.fromResult(
      Result.all(
        config.calendar.map((entry) => normalizeMarketCalendarResult([entry], { start: entry.date, end: entry.date })),
      ),
    )
    const sessions = normalizedCalendars.map((calendar) => calendar.providerSessions[0])
    const referenceSessions = normalizedCalendars
      .flatMap((calendar) =>
        calendar.providerSessions.map((session) => ({
          date: session.date,
          openAt: session.regularOpenAt,
          closeAt: session.regularCloseAt,
        })),
      )
      .toSorted((a, b) => a.date.localeCompare(b.date))
    const sessionFor = (order: ReplayOrder) =>
      sessions.find((session) => session?.date === newYorkDate.format(Date.parse(order.submittedAt)))
    const expirationAt = (order: ReplayOrder) => {
      const session = sessionFor(order)
      return order.timeInForce !== TimeInForce.Day || !isWorking(order) || session === undefined
        ? undefined
        : order.extendedHours
          ? session.sessionCloseAt
          : session.regularCloseAt
    }
    const expireOrders = (atMs: number) =>
      Effect.gen(function* () {
        const current = yield* SynchronizedRef.get(state)
        if (
          !current.orders.some(({ order }) => {
            const closeAt = expirationAt(order)
            return closeAt !== undefined && atMs >= Date.parse(closeAt)
          })
        )
          return
        yield* SynchronizedRef.updateEffect(state, (latest) => {
          const orders = latest.orders.map((record) => {
            const closeAt = expirationAt(record.order)
            return closeAt === undefined || atMs < Date.parse(closeAt)
              ? record
              : {
                  ...record,
                  order: {
                    ...record.order,
                    status: OrderStatus.Expired,
                    updatedAt: closeAt,
                    observedAt: utcInstantFromEpochMillis(atMs),
                  },
                }
          })
          const next = { ...latest, orders: reconcileProtectionGroups(orders, utcInstantFromEpochMillis(atMs)) }
          return retainState(next, utcInstantFromEpochMillis(atMs)).pipe(Effect.as(next))
        })
      })
    const valuationQuoteUsable = (
      quote: ObservedMarketValue<IntradayQuote> | undefined,
      symbol: string,
      nowMs: number,
    ): quote is ObservedMarketValue<IntradayQuote> => {
      const rejection = replayQuoteRejection(quote, symbol, nowMs, {
        ...config.protocol,
        ...jevMarketForSymbol(symbol),
      })
      return rejection === null || rejection === ReplayQuoteRejection.Stale
    }
    const executeQuote = (
      side: OrderSide,
      quantity: string,
      limit: string,
      quote: IntradayQuote,
      consumedLiquidityMicros = 0n,
    ) =>
      Result.gen(function* () {
        const displayedQuantityAtoms = yield* quantityFromNumber(
          side === OrderSide.Buy ? quote.askSize : quote.bidSize,
        ).pipe(Result.mapError((cause) => new ReplayBrokerFailure({ message: 'invalid displayed quantity', cause })))
        const budgetMicros = (displayedQuantityAtoms * BigInt(config.assumptions.availableLiquidityPpm)) / MICROS
        const remainingMicros = budgetMicros > consumedLiquidityMicros ? budgetMicros - consumedLiquidityMicros : 0n
        const metadata = asset(quote.symbol)
        if (metadata === undefined)
          return yield* Result.fail(new ReplayBrokerFailure({ message: 'Missing frozen instrument metadata' }))
        const instrument = {
          symbol: quote.symbol,
          market: instrumentMarket(quote.symbol),
          minimumQuantityAtoms: BigInt(metadata.minimumQuantityAtoms),
          quantityIncrementAtoms: BigInt(metadata.quantityIncrementAtoms),
          priceIncrementAtoms: BigInt(metadata.priceIncrementAtoms),
        }
        const input = {
          instrument: {
            ...instrument,
            ...instrumentQuantityTerms(instrument, metadata.fractionable && config.fractionalTrading),
          },
          quote: {
            priceMicros: yield* numberToMicros(side === OrderSide.Buy ? quote.askPrice : quote.bidPrice, 'quote.price'),
            displayedQuantityAtoms: remainingMicros,
          },
          executionModel: config.protocol.executionModel,
          assumptions: { ...config.assumptions, availableLiquidityPpm: 1_000_000 },
        }
        return yield* simulateIntradayReplayExecution({
          ...input,
          order: {
            side: side === OrderSide.Buy ? IntentSide.Buy : IntentSide.Sell,
            quantityAtoms: BigInt(quantity),
            limitPriceMicros: BigInt(limit),
          },
        })
      })
    const settleOrder = (
      brokerOrderId: string,
      arrivedAt: string,
      quote: ObservedMarketValue<IntradayQuote> | undefined,
      unavailableReason: ReplayQuoteRejection | 'outside-regular-session' | null,
      initialArrival = false,
    ) =>
      SynchronizedRef.updateEffect(state, (current) =>
        Effect.fromResult(
          Result.gen(function* () {
            const record = current.orders.find((entry) => entry.order.brokerOrderId === brokerOrderId)
            if (
              record === undefined ||
              !isOpen(record.order) ||
              (!initialArrival && record.order.firstArrivedAt === undefined)
            )
              return current
            const latest = record.executions.at(-1)
            if (
              quote !== undefined &&
              latest?.quote !== null &&
              latest?.quote !== undefined &&
              latest.quote.sourceTopic === quote.value.sourceTopic &&
              latest.quote.sourcePartition === quote.value.sourcePartition &&
              latest.quote.sourceOffset === quote.value.sourceOffset &&
              latest.quote.availableAtMs === quote.availableAtMs
            )
              return current
            let previous =
              initialArrival && record.order.firstArrivedAt === undefined
                ? { ...record.order, firstArrivedAt: arrivedAt, updatedAt: arrivedAt, observedAt: arrivedAt }
                : record.order
            const acceptedWithoutTrigger = () =>
              previous === record.order
                ? current
                : {
                    ...current,
                    orders: current.orders.map((entry) =>
                      entry.order.brokerOrderId === brokerOrderId ? { ...entry, order: previous } : entry,
                    ),
                  }
            if (previous.orderType === OrderType.StopLimit && previous.stopTriggeredAt === undefined) {
              if (unavailableReason !== null || quote === undefined) return acceptedWithoutTrigger()
              const bid = yield* numberToMicros(quote.value.bidPrice, 'stop trigger bid')
              if (bid > BigInt(previous.stopPriceMicros ?? '0')) return acceptedWithoutTrigger()
              previous = { ...previous, stopTriggeredAt: arrivedAt }
            }
            const remaining = BigInt(previous.quantityAtoms) - BigInt(previous.filledQuantityAtoms)
            const executionIndex = record.executions.length + 1
            const arrival = {
              submittedAt: previous.submittedAt,
              arrivedAt,
              maximumQuoteAgeMs: config.protocol.maximumQuoteAgeMs,
              quote,
            }
            let outcome:
              | ReplayExecutionOutcome
              | {
                  readonly status: 'unavailable'
                  readonly reason: ReplayQuoteRejection | 'outside-regular-session'
                }
            if (unavailableReason !== null) outcome = { status: 'unavailable', reason: unavailableReason }
            else {
              if (quote === undefined)
                return yield* Result.fail(new ReplayBrokerFailure({ message: 'Validated arrival quote is missing' }))
              const consumed = consumedQuoteLiquidity(
                current.ledger.fills,
                quoteLiquidityKey(previous.symbol, previous.side, {
                  topic: quote.value.sourceTopic,
                  partition: quote.value.sourcePartition,
                  offset: quote.value.sourceOffset,
                  availableAtMs: quote.availableAtMs,
                }),
              )
              outcome = yield* executeQuote(
                previous.side,
                remaining.toString(),
                previous.limitPriceMicros,
                quote.value,
                consumed,
              )
            }
            let execution = makeReplayOrderExecution({
              ...arrival,
              outcome,
            })
            const day = previous.timeInForce !== TimeInForce.ImmediateOrCancel
            let order: ReplayOrder = day
              ? { ...previous, observedAt: arrivedAt, updatedAt: arrivedAt }
              : {
                  ...previous,
                  observedAt: arrivedAt,
                  updatedAt: arrivedAt,
                  canceledAt: arrivedAt,
                  status: OrderStatus.Canceled,
                }
            let nextLedger = current.ledger
            const fees = [...current.fees]
            const fills = [...current.fills]
            if (outcome.status === 'filled' && quote !== undefined) {
              const fill: ReplayBrokerFill = {
                executionIndex,
                symbol: previous.symbol,
                side: previous.side,
                observedAt: arrivedAt,
                quantityAtoms: outcome.filledQuantityAtoms.toString(),
                priceMicros: outcome.fillPriceMicros.toString(),
                notionalMicros: outcome.fillNotionalMicros.toString(),
                brokerOrderId,
                clientOrderId: previous.clientOrderId,
                quoteSource: {
                  topic: quote.value.sourceTopic,
                  partition: quote.value.sourcePartition,
                  offset: quote.value.sourceOffset,
                  availableAtMs: quote.availableAtMs,
                },
              }
              const applied = applyReplayFill(
                current.ledger,
                fill,
                remaining.toString(),
                config.protocol.executionModel,
                config.assumptions.feeMultiplierPpm,
              )
              if (Result.isFailure(applied)) {
                if (
                  applied.failure._tag !== 'IntradayReplayLedgerOversell' &&
                  applied.failure._tag !== 'IntradayReplayLedgerInsufficientCash'
                )
                  return yield* Result.fail(
                    new ReplayBrokerFailure({ message: 'Replay fill accounting failed', cause: applied.failure }),
                  )
                order = {
                  ...previous,
                  status: OrderStatus.Rejected,
                  failedAt: arrivedAt,
                  updatedAt: arrivedAt,
                  observedAt: arrivedAt,
                }
                execution = {
                  ...execution,
                  outcome: {
                    status: 'rejected',
                    reason: applied.failure._tag === 'IntradayReplayLedgerOversell' ? 'oversell' : 'insufficient-cash',
                  },
                }
              } else {
                nextLedger = applied.success
                const fee = replayFeeActivity(
                  accountId,
                  fill,
                  current.ledger.executionFeesMicros,
                  nextLedger.executionFeesMicros,
                  config.assumptions.feeMultiplierPpm,
                )
                if (fee !== null) fees.push(fee)
                const totalQuantity = BigInt(previous.filledQuantityAtoms) + outcome.filledQuantityAtoms
                const totalNotional = nextLedger.fills
                  .filter((value) => value.brokerOrderId === brokerOrderId)
                  .reduce((sum, value) => sum + BigInt(value.notionalMicros), 0n)
                const complete = totalQuantity === BigInt(previous.quantityAtoms)
                order = {
                  ...previous,
                  observedAt: arrivedAt,
                  updatedAt: arrivedAt,
                  filledAt: arrivedAt,
                  ...(complete || day ? {} : { canceledAt: arrivedAt }),
                  status: complete ? OrderStatus.Filled : day ? OrderStatus.PartiallyFilled : OrderStatus.Canceled,
                  filledQuantityAtoms: totalQuantity.toString(),
                  filledAveragePriceMicros: (
                    (totalNotional * 1_000_000_000n + totalQuantity / 2n) /
                    totalQuantity
                  ).toString(),
                }
                fills.push({
                  accountId,
                  activityId: `fill::${String(fills.length).padStart(16, '0')}::${brokerOrderId}::${executionIndex}`,
                  cumulativeQuantityAtoms: order.filledQuantityAtoms,
                  leavesQuantityAtoms: (BigInt(previous.quantityAtoms) - totalQuantity).toString(),
                  priceAtoms: (outcome.fillPriceMicros * 1000n).toString(),
                  quantityAtoms: outcome.filledQuantityAtoms.toString(),
                  side: previous.side,
                  symbol: previous.symbol,
                  transactionTime: arrivedAt,
                  brokerOrderId,
                  type: complete ? TradeActivityType.Fill : TradeActivityType.PartialFill,
                  orderStatus: order.status,
                })
              }
            }
            return {
              ...current,
              ledger: nextLedger,
              fees,
              fills,
              orders: reconcileProtectionGroups(
                current.orders.map((entry) =>
                  entry.order.brokerOrderId === brokerOrderId
                    ? { ...entry, order, executions: [...entry.executions, execution] }
                    : entry,
                ),
                arrivedAt,
              ),
            }
          }),
        ).pipe(Effect.tap((next) => (next === current ? Effect.void : retainState(next, arrivedAt)))),
      )
    const settleOrderAndChildren = (
      brokerOrderId: string,
      arrivedAt: string,
      quote: ObservedMarketValue<IntradayQuote> | undefined,
      unavailableReason: ReplayQuoteRejection | 'outside-regular-session' | null,
      initialArrival = false,
    ) =>
      Effect.gen(function* () {
        yield* settleOrder(brokerOrderId, arrivedAt, quote, unavailableReason, initialArrival)
        const current = yield* SynchronizedRef.get(state)
        for (const { order } of current.orders) {
          if (order.parentBrokerOrderId === brokerOrderId && order.firstArrivedAt !== undefined && isOpen(order))
            yield* settleOrder(order.brokerOrderId, arrivedAt, quote, unavailableReason)
        }
      })
    const observeMarket = (atMs: number, quote: ObservedMarketValue<IntradayQuote> | null) =>
      Effect.gen(function* () {
        if (!Number.isSafeInteger(atMs) || (quote !== null && quote.availableAtMs !== atMs))
          return yield* new ReplayBrokerFailure({ message: 'Replay broker market availability is invalid' })
        yield* expireOrders(atMs)
        if (quote === null) return
        const current = yield* SynchronizedRef.get(state)
        for (const record of current.orders) {
          const order = record.order
          const previous = record.executions.at(-1)
          if (
            order.timeInForce === TimeInForce.ImmediateOrCancel ||
            order.firstArrivedAt === undefined ||
            Date.parse(order.firstArrivedAt) > atMs ||
            !isOpen(order) ||
            order.symbol !== quote.value.symbol ||
            (previous !== undefined && Date.parse(previous.arrivedAt) > atMs) ||
            (previous?.quote?.sourceTopic === quote.value.sourceTopic &&
              previous.quote.sourcePartition === quote.value.sourcePartition &&
              previous.quote.sourceOffset === quote.value.sourceOffset &&
              previous.quote.availableAtMs === quote.availableAtMs)
          )
            continue
          yield* settleOrderAndChildren(
            order.brokerOrderId,
            utcInstantFromEpochMillis(atMs),
            quote,
            replayQuoteRejection(quote, order.symbol, atMs, {
              ...config.protocol,
              ...jevMarketForSymbol(order.symbol),
            }),
          )
        }
      })
    const closingEquity = (current: ReplayBrokerState, closeAt: string) =>
      Effect.gen(function* () {
        let closingLedger = yield* Effect.fromResult(createReplayLedger<ReplayBrokerFill>(config.openingCashMicros))
        for (const fill of current.ledger.fills) {
          if (fill.observedAt > closeAt) break
          const order = current.orders.find((entry) => entry.order.brokerOrderId === fill.brokerOrderId)?.order
          if (order === undefined || order.quantityAtoms === undefined)
            return yield* new ReplayBrokerFailure({ message: 'Session close has an unknown order' })
          closingLedger = yield* Effect.fromResult(
            applyReplayFill(
              closingLedger,
              fill,
              order.quantityAtoms,
              config.protocol.executionModel,
              config.assumptions.feeMultiplierPpm,
            ),
          )
        }
        let equity = BigInt(closingLedger.cashMicros)
        let valuationQualified = true
        for (const position of closingLedger.positions) {
          const atMs = Date.parse(closeAt)
          const quote = yield* config.quoteAt(position.symbol, atMs, null)
          if (!valuationQuoteUsable(quote, position.symbol, atMs))
            return yield* new ReplayBrokerFailure({ message: 'Session close has no retained valuation quote' })
          if (
            !quoteUsable(quote, position.symbol, atMs) ||
            !Number.isFinite(quote.value.bidSize) ||
            quote.value.bidSize <= 0
          )
            valuationQualified = false
          const price = yield* Effect.fromResult(numberToMicros(quote.value.bidPrice, 'mark.bid'))
          equity += yield* Effect.fromResult(notionalMicros(BigInt(position.quantityAtoms), price))
        }
        return { equityMicros: equity.toString(), valuationQualified }
      })
    if (restored !== undefined) {
      const consumedLiquidity = new Map<string, bigint>()
      const filledQuantities = new Map<string, bigint>()
      for (const fill of restored.state.ledger.fills) {
        const order = restored.state.orders.find((entry) => entry.order.brokerOrderId === fill.brokerOrderId)?.order
        const arrivedAtMs = Date.parse(fill.observedAt)
        const quote = yield* config.quoteAt(fill.symbol, arrivedAtMs, fill.quoteSource)
        if (
          order === undefined ||
          !quoteUsable(quote, fill.symbol, arrivedAtMs) ||
          arrivedAtMs < Date.parse(order.submittedAt) + config.assumptions.latencyMs ||
          quote.value.sourceTopic !== fill.quoteSource.topic ||
          quote.value.sourcePartition !== fill.quoteSource.partition ||
          quote.value.sourceOffset !== fill.quoteSource.offset ||
          quote.availableAtMs !== fill.quoteSource.availableAtMs
        )
          return yield* new ReplayBrokerFailure({ message: 'Restored fill has no matching retained arrival quote' })
        const liquidityKey = quoteLiquidityKey(fill.symbol, order.side, fill.quoteSource)
        const priorConsumption = consumedLiquidity.get(liquidityKey) ?? 0n
        const outcome = yield* Effect.fromResult(
          executeQuote(
            order.side,
            (
              replayQuantityAtFill(restored.state, order, restored.state.ledger.fills.indexOf(fill)) -
              (filledQuantities.get(order.brokerOrderId) ?? 0n)
            ).toString(),
            order.limitPriceMicros,
            quote.value,
            priorConsumption,
          ),
        )
        if (
          outcome.status !== 'filled' ||
          outcome.filledQuantityAtoms.toString() !== fill.quantityAtoms ||
          outcome.fillPriceMicros.toString() !== fill.priceMicros ||
          outcome.fillNotionalMicros.toString() !== fill.notionalMicros
        )
          return yield* new ReplayBrokerFailure({ message: 'Restored fill differs from retained quote execution' })
        consumedLiquidity.set(liquidityKey, priorConsumption + BigInt(fill.quantityAtoms))
        filledQuantities.set(
          order.brokerOrderId,
          (filledQuantities.get(order.brokerOrderId) ?? 0n) + BigInt(fill.quantityAtoms),
        )
      }
      for (const close of restored.state.sessionCloses) {
        const calendar = yield* Effect.fromResult(
          normalizeMarketCalendarResult(
            config.calendar.filter((session) => session.date === close.sessionDate),
            { start: close.sessionDate, end: close.sessionDate },
          ),
        )
        const session = calendar.providerSessions[0]
        if (session === undefined) return yield* new ReplayBrokerFailure({ message: 'Restored close has no session' })
        const equity = yield* closingEquity(restored.state, session.regularCloseAt)
        if (equity.equityMicros !== close.equityMicros || equity.valuationQualified !== close.valuationQualified)
          return yield* new ReplayBrokerFailure({
            message: 'Restored closing equity differs from retained quotes and fills',
          })
      }
    }
    const markedPositions = Effect.gen(function* () {
      const current = yield* readState
      const observedAt = yield* now
      const marked = yield* Effect.forEach(current.ledger.positions, (position) =>
        Effect.gen(function* () {
          const metadata = asset(position.symbol)
          const quote = yield* config.quoteAt(position.symbol, Date.parse(observedAt), null)
          if (metadata === undefined || !valuationQuoteUsable(quote, position.symbol, Date.parse(observedAt)))
            return yield* new ReplayBrokerFailure({
              message: `Replay position mark unavailable for ${position.symbol}`,
            })
          const price = yield* Effect.fromResult(numberToMicros(quote.value.bidPrice, 'mark.bid'))
          const value = yield* Effect.fromResult(notionalMicros(BigInt(position.quantityAtoms), price))
          const positionValue = {
            accountId,
            assetId: metadata.assetId,
            symbol: position.symbol,
            exchange: metadata.exchange,
            assetClass: metadata.assetClass,
            side: PositionSide.Long,
            quantityAtoms: position.quantityAtoms,
            costBasisMicros: position.costBasisMicros,
            averageEntryPriceMicros: (
              (BigInt(position.costBasisMicros) * 1_000_000_000n) /
              BigInt(position.quantityAtoms)
            ).toString(),
            marketPriceMicros: price.toString(),
            marketValueMicros: value.toString(),
            unrealizedPnlMicros: (value - BigInt(position.costBasisMicros)).toString(),
            observedAt,
          } satisfies Position
          return {
            position: positionValue,
            mark: {
              symbol: position.symbol,
              priceMicros: price.toString(),
              eventAt: quote.value.eventAt,
              availableAtMs: quote.availableAtMs,
              ageNanos: (
                BigInt(Date.parse(observedAt)) * 1_000_000n -
                intradayInstantNanos(quote.value.eventAt)
              ).toString(),
              staleForExecution: !quoteUsable(quote, position.symbol, Date.parse(observedAt)),
              bidLiquidityAvailable: Number.isFinite(quote.value.bidSize) && quote.value.bidSize > 0,
              topic: quote.value.sourceTopic,
              partition: quote.value.sourcePartition,
              offset: quote.value.sourceOffset,
              recordHash: quote.recordHash,
            },
          }
        }),
      )
      return {
        positions: marked.map(({ position }) => position),
        observedAt,
        valuation: {
          model: 'last-observed-bid',
          observedAt,
          marks: marked.map(({ mark }) => mark),
        } satisfies ReplayValuationEvidence,
      }
    })
    const readOrder = (find: (order: Order) => boolean, operation: 'order-by-id' | 'order-by-client-id') =>
      Effect.gen(function* () {
        const current = yield* readState
        const found = current.orders.find((entry) => find(entry.order))
        if (found === undefined)
          return yield* new BrokerReadError({
            operation,
            kind: BrokerReadErrorKind.NotFound,
            message: 'Simulated order not found',
            retryable: false,
            status: 404,
          })
        const observedAt = yield* now
        return yield* evidence(groupOrder(found.order, current.orders, observedAt), observedAt)
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof BrokerReadError ? cause : readFailure(operation, 'Replay order read failed', cause),
        ),
      )

    const read: BrokerReadShape = {
      account: Effect.gen(function* () {
        yield* synchronizeReferenceEquities
        const current = yield* readState
        const { positions, observedAt } = yield* markedPositions
        const date = newYorkDate.format(Date.parse(observedAt))
        const previousSession = referenceSessions
          .filter((session) => session.date < date && Date.parse(session.closeAt) >= startedAtMs)
          .toSorted((a, b) => a.date.localeCompare(b.date))
          .at(-1)
        const previousClose = current.sessionCloses.find((session) => session.sessionDate === previousSession?.date)
        if (previousSession !== undefined && previousClose === undefined)
          return yield* new ReplayBrokerFailure({ message: `Missing prior session equity for ${previousSession.date}` })
        const equity =
          BigInt(current.ledger.cashMicros) +
          positions.reduce((total, position) => total + BigInt(position.marketValueMicros), 0n)
        return yield* evidence(
          {
            cryptoStatus: cryptoEnabled ? 'ACTIVE' : null,
            cryptoFeeTier: null,
            cashReportingQuantumMicros: '1' as const,
            nonMarginableBuyingPowerMicros: cryptoEnabled ? current.ledger.cashMicros : null,

            id: accountId,
            status: AccountStatus.Active,
            currency: 'USD',
            cashMicros: current.ledger.cashMicros,
            equityMicros: equity.toString(),
            lastEquityMicros: previousClose?.equityMicros ?? current.ledger.openingCashMicros,
            buyingPowerMicros: current.ledger.cashMicros,
            accountBlocked: false,
            tradingBlocked: false,
            tradeSuspendedByUser: false,
            observedAt,
          } satisfies Account,
          observedAt,
        )
      }).pipe(Effect.mapError((cause) => readFailure('account', 'Replay account read failed', cause))),
      positions: Effect.gen(function* () {
        const { positions, observedAt } = yield* markedPositions
        return yield* evidence(positions, observedAt)
      }).pipe(Effect.mapError((cause) => readFailure('positions', 'Replay positions read failed', cause))),
      accountConfiguration: Effect.gen(function* () {
        const observedAt = yield* now
        return yield* evidence(
          yield* Effect.fromResult(
            normalizeAccountConfigurationResult({ fractional_trading: config.fractionalTrading }, observedAt),
          ),
          observedAt,
        )
      }).pipe(
        Effect.mapError((cause) => readFailure('account-configuration', 'Replay account configuration failed', cause)),
      ),
      assetBySymbol: (symbol) =>
        Effect.gen(function* () {
          const found = asset(symbol)
          if (found === undefined) return yield* readFailure('asset-by-symbol', `Missing captured asset ${symbol}`)
          const observedAt = yield* now
          return yield* evidence({ ...found, observedAt }, observedAt)
        }).pipe(Effect.mapError((cause) => readFailure('asset-by-symbol', 'Replay asset read failed', cause))),
      marketCalendar: (query) =>
        Effect.gen(function* () {
          const request = yield* Effect.fromResult(
            Schema.decodeUnknownResult(MarketCalendarQueryBase, strictParseOptions)(query),
          )
          const calendar = yield* Effect.fromResult(
            normalizeMarketCalendarResult(
              config.calendar.filter((entry) => entry.date >= request.start && entry.date <= request.end),
              request,
            ),
          )
          return yield* evidence(calendar, yield* now)
        }).pipe(Effect.mapError((cause) => readFailure('market-calendar', 'Replay calendar read failed', cause))),
      orderById: (id) => readOrder((order) => order.brokerOrderId === id, 'order-by-id'),
      orderByClientId: (id) => readOrder((order) => order.clientOrderId === id, 'order-by-client-id'),
      orders: (query) =>
        Effect.gen(function* () {
          const current = yield* readState
          const observedAt = yield* now
          const orders = current.orders
            .map((entry) => entry.order)
            .filter(
              (order) =>
                (query?.status === 'open'
                  ? isWorking(order)
                  : order.parentBrokerOrderId === undefined && (query?.status !== 'closed' || !isWorking(order))) &&
                (query?.symbols === undefined || query.symbols.includes(order.symbol)) &&
                (query?.side === undefined || query.side === order.side) &&
                (query?.after === undefined || order.createdAt > query.after) &&
                (query?.until === undefined || order.createdAt < query.until),
            )
            .toSorted((a, b) => (query?.direction === 'asc' ? 1 : -1) * a.createdAt.localeCompare(b.createdAt))
          return yield* evidence(
            orders
              .slice(0, query?.limit ?? 500)
              .map((order) =>
                query?.status === 'open'
                  ? publicOrder(order, observedAt)
                  : groupOrder(order, current.orders, observedAt),
              ),
            observedAt,
          )
        }).pipe(Effect.mapError((cause) => readFailure('orders', 'Replay orders read failed', cause))),
      fillActivities: (query) =>
        Effect.gen(function* () {
          const current = yield* readState
          const values = current.fills
            .filter(
              (fill) =>
                (query?.date === undefined || fill.transactionTime.slice(0, 10) === query.date) &&
                (query?.after === undefined || fill.transactionTime > query.after) &&
                (query?.until === undefined || fill.transactionTime < query.until),
            )
            .toSorted(
              (a, b) =>
                (query?.direction === 'asc' ? 1 : -1) *
                (a.transactionTime.localeCompare(b.transactionTime) || a.activityId.localeCompare(b.activityId)),
            )
          const start =
            query?.pageToken === undefined ? 0 : values.findIndex((fill) => fill.activityId === query.pageToken) + 1
          if (query?.pageToken !== undefined && start === 0)
            return yield* readFailure('fill-activities', 'Unknown replay fill page token')
          const items = values.slice(start, start + (query?.pageSize ?? 100))
          const last = items.at(-1)
          return yield* evidence(
            {
              items,
              ...(last !== undefined && start + items.length < values.length ? { nextPageToken: last.activityId } : {}),
            },
            yield* now,
          )
        }).pipe(Effect.mapError((cause) => readFailure('fill-activities', 'Replay fill read failed', cause))),
      feeActivities: (query) =>
        Effect.gen(function* () {
          const current = yield* readState
          const values = current.fees
            .filter((fee) => query?.date === undefined || fee.date === query.date)
            .toSorted(
              (a, b) =>
                (query?.direction === 'asc' ? 1 : -1) *
                (a.date.localeCompare(b.date) || a.activityId.localeCompare(b.activityId)),
            )
          const start =
            query?.pageToken === undefined ? 0 : values.findIndex((fee) => fee.activityId === query.pageToken) + 1
          if (query?.pageToken !== undefined && start === 0)
            return yield* readFailure('fee-activities', 'Unknown replay fee page token')
          const items = values.slice(start, start + (query?.pageSize ?? 100))
          const last = items.at(-1)
          return yield* evidence(
            {
              items,
              ...(last !== undefined && start + items.length < values.length ? { nextPageToken: last.activityId } : {}),
            },
            yield* now,
          )
        }).pipe(Effect.mapError((cause) => readFailure('fee-activities', 'Replay fee read failed', cause))),
    }

    const mutation: BrokerMutationShape = {
      submit: (intent: Intent) =>
        Effect.gen(function* () {
          yield* readState
          const prepared = yield* Effect.fromResult(prepareSubmit(intent, accountId))
          const request = prepared.request
          if (!config.fractionalTrading && orderRequestRequiresFractionalTrading(request))
            return yield* mutationFailure(
              MutationOperation.Submit,
              'Replay account configuration disables fractional trading',
            )
          const observedAt = yield* config.submissionTime ?? now
          const metadata = asset(intent.symbol)
          if (metadata === undefined || !metadata.tradable)
            return yield* mutationFailure(MutationOperation.Submit, 'Captured asset is not tradable')
          const limit = yield* Effect.fromResult(decimalToMicrosResult(request.limit_price, false, 'limit price'))
          const brokerOrderId = simulatedUuid(
            yield* Effect.fromResult(hash({ runId: config.runId, clientOrderId: intent.clientOrderId })),
          )
          const pending: ReplayOrder = {
            accountId,
            brokerOrderId,
            clientOrderId: intent.clientOrderId,
            createdAt: observedAt,
            updatedAt: observedAt,
            submittedAt: observedAt,
            assetId: metadata.assetId,
            symbol: intent.symbol,
            assetClass: metadata.assetClass,
            quantityAtoms: intent.quantityAtoms,
            filledQuantityAtoms: '0',
            orderClass:
              request.order_class === 'bracket'
                ? OrderClass.Bracket
                : request.order_class === 'oco'
                  ? OrderClass.OneCancelsOther
                  : OrderClass.Simple,
            orderType: request.type,
            ...(intent.protection === undefined ? {} : { nativeProtection: intent.protection }),
            ...(intent.protection?._tag === 'StopLimit' ? { stopPriceMicros: intent.protection.stopPriceMicros } : {}),
            side: request.side,
            timeInForce: request.time_in_force,
            limitPriceMicros: limit,
            status: OrderStatus.New,
            extendedHours: request.extended_hours,
            observedAt,
          }
          const children: ReplayBrokerOrder[] = []
          if (intent.protection !== undefined && intent.protection._tag !== 'StopLimit') {
            const terms = intent.protection
            for (const kind of terms._tag === 'Bracket' ? ['profit', 'stop'] : ['stop']) {
              const clientOrderId = `${intent.clientOrderId}-${kind}`
              const childId = simulatedUuid(yield* Effect.fromResult(hash({ runId: config.runId, clientOrderId })))
              const { nativeProtection: _terms, ...base } = pending
              children.push({
                requestHash: prepared.requestHash,
                executions: [],
                order: {
                  ...base,
                  clientOrderId,
                  brokerOrderId: childId,
                  parentBrokerOrderId: brokerOrderId,
                  side: OrderSide.Sell,
                  orderClass: OrderClass.Simple,
                  orderType: kind === 'stop' ? OrderType.StopLimit : OrderType.Limit,
                  limitPriceMicros: kind === 'stop' ? terms.stopLimitPriceMicros : terms.profitLimitPriceMicros,
                  ...(kind === 'stop' ? { stopPriceMicros: terms.stopPriceMicros } : {}),
                  status: terms._tag === 'Bracket' ? OrderStatus.Held : OrderStatus.New,
                },
              })
            }
          }
          const existing = yield* SynchronizedRef.modify(state, (current) => {
            const previous = current.orders.find((entry) => entry.order.clientOrderId === intent.clientOrderId)
            return [
              previous,
              previous === undefined
                ? {
                    ...current,
                    orders: [
                      ...current.orders,
                      { requestHash: prepared.requestHash, order: pending, executions: [] },
                      ...children,
                    ],
                  }
                : current,
            ] as const
          })
          if (existing !== undefined && existing.requestHash !== prepared.requestHash)
            return yield* mutationFailure(
              MutationOperation.Submit,
              'Client order ID conflicts with a different replay request',
            )
          if (existing === undefined) {
            const delivery = yield* Effect.gen(function* () {
              const submittedAtMs = Date.parse(observedAt)
              const sessionDate = newYorkDate.format(submittedAtMs)
              const calendar = yield* read.marketCalendar({ start: sessionDate, end: sessionDate })
              const session = calendar.value.providerSessions.find((value) => value.date === sessionDate)
              const continuous = instrumentMarket(intent.symbol) === MarketKind.Crypto
              const closeMs = continuous
                ? Number.POSITIVE_INFINITY
                : session === undefined
                  ? submittedAtMs
                  : Date.parse(request.extended_hours ? session.sessionCloseAt : session.regularCloseAt)
              // A regular-session IOC still in transit expires at the close. It cannot fill after the session.
              const expectedArrivalMs = Math.max(
                submittedAtMs,
                Math.min(submittedAtMs + config.assumptions.latencyMs, closeMs),
              )
              if (config.advanceToArrival === undefined) yield* Effect.sleep(expectedArrivalMs - submittedAtMs)
              else {
                yield* config.advanceToArrival(expectedArrivalMs)
                if ((yield* Clock.currentTimeMillis) !== expectedArrivalMs)
                  return yield* new ReplayBrokerFailure({
                    message: 'Historical arrival scheduler did not reach the exact broker delivery time',
                  })
              }
              const arrivedAtMs = yield* Clock.currentTimeMillis
              const arrivedAt = yield* now
              const sessionOpen =
                continuous ||
                (session !== undefined &&
                  submittedAtMs >= Date.parse(request.extended_hours ? session.sessionOpenAt : session.regularOpenAt) &&
                  arrivedAtMs < closeMs)
              const quote = sessionOpen ? yield* config.quoteAt(intent.symbol, arrivedAtMs, null) : undefined
              const unavailableReason = sessionOpen
                ? replayQuoteRejection(quote, intent.symbol, arrivedAtMs, {
                    ...config.protocol,
                    ...jevMarketForSymbol(intent.symbol),
                  })
                : 'outside-regular-session'
              yield* settleOrderAndChildren(brokerOrderId, arrivedAt, quote, unavailableReason, true)
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.gen(function* () {
                      const failedAt = yield* now
                      yield* updateCommittedState(failedAt, (current) => ({
                        ...current,
                        orders: reconcileProtectionGroups(
                          current.orders.map((entry) =>
                            entry.order.brokerOrderId === brokerOrderId && isOpen(entry.order)
                              ? {
                                  ...entry,
                                  deliveryFailure: causeSummary(Cause.squash(exit.cause)),
                                  order: {
                                    ...entry.order,
                                    status: OrderStatus.Canceled,
                                    canceledAt: failedAt,
                                    updatedAt: failedAt,
                                    observedAt: failedAt,
                                  },
                                }
                              : entry,
                          ),
                          failedAt,
                        ),
                      }))
                    }),
              ),
              Effect.forkIn(brokerScope, { startImmediately: true }),
            )
            yield* Fiber.join(delivery)
          }
          const receipt = yield* read.orderById(brokerOrderId)
          return { requestHash: prepared.requestHash, order: receipt.value, evidence: receipt.evidence }
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof BrokerMutationError
              ? cause
              : new BrokerMutationError({
                  operation: MutationOperation.Submit,
                  failure: MutationFailure.Unknown,
                  outcome: MutationOutcome.Unknown,
                  message: 'Simulated broker submit failed; recover through order lookup',
                  cause: causeSummary(cause),
                }),
          ),
        ),
      cancel: (brokerOrderId) =>
        Effect.gen(function* () {
          const prepared = yield* Effect.fromResult(prepareCancel(brokerOrderId))
          const observedAt = yield* now
          yield* read.orderById(brokerOrderId)
          const target = (yield* readState).orders.find((entry) => entry.order.brokerOrderId === brokerOrderId)?.order
          const groupId = target?.parentBrokerOrderId ?? brokerOrderId
          yield* updateCommittedState(observedAt, (current) => ({
            ...current,
            orders: current.orders.map((entry) =>
              (entry.order.brokerOrderId === groupId || entry.order.parentBrokerOrderId === groupId) &&
              isWorking(entry.order)
                ? {
                    ...entry,
                    order: {
                      ...entry.order,
                      observedAt,
                      updatedAt: observedAt,
                      canceledAt: observedAt,
                      status: OrderStatus.Canceled,
                    },
                  }
                : entry,
            ),
          }))
          return yield* Effect.fromResult(
            classifyCancelResponse({
              ...prepared,
              status: 204,
              requestId: `replay-cancel-${prepared.requestHash}`,
              observedAt,
            }),
          )
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof BrokerMutationError
              ? cause
              : mutationFailure(MutationOperation.Cancel, 'Simulated cancel failed'),
          ),
        ),
      orderById: read.orderById,
      orderByClientId: read.orderByClientId,
    }
    const synchronizeReferenceEquities = Effect.gen(function* () {
      const observedAt = yield* now
      let current = yield* readState
      for (const session of referenceSessions) {
        if (
          Date.parse(session.closeAt) < startedAtMs ||
          session.closeAt > observedAt ||
          current.sessionCloses.some((close) => close.sessionDate === session.date)
        )
          continue
        const closing = yield* closingEquity(current, session.closeAt)
        const close = { sessionDate: session.date, ...closing }
        yield* updateCommittedState(observedAt, (value) =>
          value.sessionCloses.some((prior) => prior.sessionDate === session.date)
            ? value
            : { ...value, sessionCloses: [...value.sessionCloses, close] },
        )
        current = yield* readState
        const retained = current.sessionCloses.find((prior) => prior.sessionDate === session.date)
        if (retained?.equityMicros !== close.equityMicros || retained.valuationQualified !== close.valuationQualified)
          return yield* new ReplayBrokerFailure({ message: 'Broker reference equity changed after it was recorded' })
      }
    })
    const valuationAt = (input: string) =>
      Effect.gen(function* () {
        const at = yield* Effect.fromResult(Schema.decodeUnknownResult(UtcInstantSchema, strictParseOptions)(input))
        if (Date.parse(at) > (yield* Clock.currentTimeMillis))
          return yield* new ReplayBrokerFailure({
            message: 'Valuation cannot be captured before its requested boundary',
          })
        const current = yield* readState
        if (current.orders.some((record) => record.deliveryFailure !== undefined))
          return yield* new ReplayBrokerFailure({ message: 'Cannot value simulation after a broker delivery failure' })
        const closing = yield* closingEquity(current, at)
        yield* synchronizeReferenceEquities
        const openOrderCount = current.orders.filter(
          ({ order }) => order.submittedAt <= at && (isOpen(order) || order.updatedAt > at),
        ).length
        const referenceValuationQualified = (yield* readState).sessionCloses.every(
          (close) =>
            close.valuationQualified ||
            !referenceSessions.some((session) => session.date === close.sessionDate && session.closeAt <= at),
        )
        return {
          at,
          ...closing,
          valuationQualified: closing.valuationQualified && referenceValuationQualified,
          openOrderCount,
        }
      })
    const checkpoint = Effect.gen(function* () {
      const observedAt = yield* now
      return yield* Effect.fromResult(makeReplayBrokerCheckpoint(config, yield* readState, observedAt))
    })
    const advanceToArrival = config.advanceToArrival
    const waitForSnapshotRetry = (milliseconds: number) =>
      advanceToArrival === undefined
        ? Effect.sleep(milliseconds)
        : Clock.currentTimeMillis.pipe(
            Effect.flatMap((at) => advanceToArrival(at + milliseconds)),
            Effect.mapError((cause) => readFailure('preflight', 'Replay snapshot retry could not advance', cause)),
          )
    return {
      accountId,
      sourceManifestHash: config.sourceManifestHash,
      read: {
        ...read,
        projection: {
          fresh: read,
          invalidate: Effect.void,
          withMutation: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
          snapshot: readStableBrokerSnapshot(read, now, waitForSnapshotRetry).pipe(
            Effect.mapError((cause) => readFailure('preflight', 'Replay broker snapshot failed', cause)),
          ),
          submissionSnapshot: () =>
            Effect.all({
              account: read.account,
              positions: read.positions,
              openOrders: read.orders({ status: OrderCollection.Open, limit: 500 }),
            }),
        },
      },
      mutation,
      observeMarket,
      valuationAt,
      valuation: markedPositions.pipe(Effect.map(({ valuation }) => valuation)),
      snapshot: readState,
      checkpoint,
    }
  })
