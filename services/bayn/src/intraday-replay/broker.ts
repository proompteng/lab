import { Cause, Clock, Data, Effect, Exit, Fiber, Ref, Result, Schema, SynchronizedRef } from 'effect'

import {
  AccountStatus,
  AssetClass,
  OrderClass,
  OrderSide,
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
import { prepareCancel, prepareSubmit } from '../broker/alpaca-mutations/decisions'
import {
  BrokerMutationError,
  MutationFailure,
  MutationOperation,
  type BrokerMutationShape,
  causeSummary,
} from '../broker/alpaca-mutations/model'
import { MutationOutcome, OrderSide as IntentSide, type Intent } from '../execution/contracts'
import { numberToMicros, notionalMicros, MICROS } from '../execution-model'
import { canonicalHashV1Result } from '../hash'
import { Sha256Schema, strictParseOptions } from '../schemas'
import type { IntradayQuote } from '../market-data/intraday/model'
import { intradayInstantNanos } from '../market-data/intraday/time'
import type { ObservedMarketValue } from '../market-data/streaming/projection'
import type { IntradayMomentumProtocol } from '../strategy/intraday-momentum/protocol'
import { applyReplayFill, createReplayLedger, type EconomicReplayFill, type ReplayLedger } from './ledger'
import { simulateIntradayReplayIocCore } from './execution-core'
import type { IntradayReplayIocAssumptions } from './execution'
import {
  makeReplayBrokerCheckpoint,
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
  /** Commit terminal IOC state before publishing it to broker readers or returning a response. */
  readonly retainSettlement?: (checkpoint: ReplayBrokerCheckpoint) => Effect.Effect<void, ReplayBrokerFailure>
  readonly openingCashMicros: string
  readonly protocol: IntradayMomentumProtocol
  readonly assumptions: IntradayReplayIocAssumptions & { readonly latencyMs: number; readonly feeMultiplierPpm: number }
  readonly fractionalTrading: boolean
  readonly assets: readonly AssetObservation[]
  readonly calendar: typeof MarketCalendarResponseSchema.Type
  /** A historical runner advances retained arrivals and both clocks to this exact delivery instant. */
  readonly advanceToArrival?: (atMs: number) => Effect.Effect<void, ReplayBrokerFailure>
  readonly quoteAt: (
    symbol: string,
    nowMs: number,
  ) => Effect.Effect<ObservedMarketValue<IntradayQuote> | undefined, ReplayBrokerFailure>
}

export interface ReplayBrokerFill extends EconomicReplayFill {
  readonly brokerOrderId: string
  readonly clientOrderId: string
  readonly quoteSource: {
    readonly topic: string
    readonly partition: number
    readonly offset: string
    readonly availableAtMs: number
  }
}

interface ReplayBrokerOrder {
  readonly deliveryFailure?: Readonly<Record<string, string>>
  readonly requestHash: string
  readonly order: Order
}
export interface ReplayBrokerState {
  readonly schemaVersion: 'bayn.simulated-broker-state.v1'
  readonly runId: string
  readonly accountId: string
  readonly ledger: ReplayLedger<ReplayBrokerFill>
  readonly orders: readonly ReplayBrokerOrder[]
  readonly fills: readonly FillActivity[]
  readonly fees: readonly FeeActivity[]
  readonly sessionCloses: readonly { readonly sessionDate: string; readonly equityMicros: string }[]
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
const newYorkDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** No HTTP client or credentials are acquired. Both ports operate on the same simulated broker state. */
export const makeReplayBroker = (config: ReplayBrokerConfig) =>
  Effect.gen(function* () {
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
    const brokerScope = yield* Effect.scope
    const accountId = `replay-${config.runId}`
    const ledger = yield* Effect.fromResult(createReplayLedger<ReplayBrokerFill>(config.openingCashMicros))
    const state = yield* SynchronizedRef.make<ReplayBrokerState>(
      restored?.state ?? {
        schemaVersion: 'bayn.simulated-broker-state.v1',
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
      return yield* SynchronizedRef.get(state)
    })
    const now = Clock.currentTimeMillis.pipe(Effect.map((value) => new Date(value).toISOString()))
    const evidence = <A>(value: A, observedAt: string): Effect.Effect<ReadResult<A>, ReplayBrokerFailure> =>
      Effect.fromResult(hash(value)).pipe(
        Effect.map((contentHash) => ({
          value,
          evidence: { requestId: `replay-${contentHash}`, status: 200, contentHash, observedAt },
        })),
      )
    const asset = (symbol: string) => config.assets.find((entry) => entry.symbol === symbol)
    const quoteUsable = (
      quote: ObservedMarketValue<IntradayQuote> | undefined,
      symbol: string,
      nowMs: number,
    ): quote is ObservedMarketValue<IntradayQuote> =>
      quote !== undefined &&
      quote.value.symbol === symbol &&
      quote.value.feed === config.protocol.feed &&
      quote.value.delayClass === config.protocol.delayClass &&
      quote.value.marketSession === 'regular' &&
      quote.value.bidPrice > 0 &&
      quote.value.askPrice >= quote.value.bidPrice &&
      Number.isFinite(quote.value.askPrice) &&
      quote.availableAtMs <= nowMs &&
      intradayInstantNanos(quote.value.eventAt) <= BigInt(nowMs) * 1_000_000n &&
      BigInt(nowMs) * 1_000_000n - intradayInstantNanos(quote.value.eventAt) <=
        BigInt(config.protocol.maximumQuoteAgeMs) * 1_000_000n
    const executeQuote = (side: OrderSide, quantity: string, limit: string, quote: IntradayQuote) =>
      Result.gen(function* () {
        return yield* simulateIntradayReplayIocCore({
          order: {
            side: side === OrderSide.Buy ? IntentSide.Buy : IntentSide.Sell,
            quantityMicros: BigInt(quantity),
            limitPriceMicros: BigInt(limit),
          },
          quote: {
            priceMicros: yield* numberToMicros(side === OrderSide.Buy ? quote.askPrice : quote.bidPrice, 'quote.price'),
            displayedQuantityMicros: yield* numberToMicros(
              side === OrderSide.Buy ? quote.askSize : quote.bidSize,
              'quote.size',
            ),
          },
          executionModel: config.protocol.executionModel,
          assumptions: config.assumptions,
        })
      })
    if (restored !== undefined) {
      for (const fill of restored.state.ledger.fills) {
        const order = restored.state.orders.find((entry) => entry.order.brokerOrderId === fill.brokerOrderId)?.order
        const arrivedAtMs = Date.parse(fill.observedAt)
        const quote = yield* config.quoteAt(fill.symbol, arrivedAtMs)
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
        const outcome = yield* Effect.fromResult(
          executeQuote(order.side, order.quantityMicros, order.limitPriceMicros, quote.value),
        )
        if (
          outcome.status !== 'filled' ||
          outcome.filledQuantityMicros.toString() !== fill.quantityMicros ||
          outcome.fillPriceMicros.toString() !== fill.priceMicros ||
          outcome.fillNotionalMicros.toString() !== fill.notionalMicros
        )
          return yield* new ReplayBrokerFailure({ message: 'Restored fill differs from retained quote execution' })
      }
      for (const close of restored.state.sessionCloses) {
        const calendar = yield* Effect.fromResult(
          normalizeMarketCalendarResult(
            config.calendar.filter((session) => session.date === close.sessionDate),
            { start: close.sessionDate, end: close.sessionDate },
          ),
        )
        const session = calendar.sessions[0]
        if (session === undefined) return yield* new ReplayBrokerFailure({ message: 'Restored close has no session' })
        let closingLedger = yield* Effect.fromResult(createReplayLedger<ReplayBrokerFill>(config.openingCashMicros))
        for (const fill of restored.state.ledger.fills) {
          if (fill.observedAt > session.closeAt) break
          const order = restored.state.orders.find((entry) => entry.order.brokerOrderId === fill.brokerOrderId)?.order
          if (order === undefined)
            return yield* new ReplayBrokerFailure({ message: 'Restored close has an unknown order' })
          closingLedger = yield* Effect.fromResult(
            applyReplayFill(
              closingLedger,
              fill,
              order.quantityMicros,
              config.protocol.executionModel,
              config.assumptions.feeMultiplierPpm,
            ),
          )
        }
        let equity = BigInt(closingLedger.cashMicros)
        for (const position of closingLedger.positions) {
          const atMs = Date.parse(session.closeAt)
          const quote = yield* config.quoteAt(position.symbol, atMs)
          if (!quoteUsable(quote, position.symbol, atMs))
            return yield* new ReplayBrokerFailure({ message: 'Restored close has no retained valuation quote' })
          const price = yield* Effect.fromResult(numberToMicros(quote.value.bidPrice, 'mark.bid'))
          equity += yield* Effect.fromResult(notionalMicros(BigInt(position.quantityMicros), price))
        }
        if (equity.toString() !== close.equityMicros)
          return yield* new ReplayBrokerFailure({
            message: 'Restored closing equity differs from retained quotes and fills',
          })
      }
    }
    const markedPositions = Effect.gen(function* () {
      const current = yield* readState
      const observedAt = yield* now
      const positions = yield* Effect.forEach(current.ledger.positions, (position) =>
        Effect.gen(function* () {
          const metadata = asset(position.symbol)
          const quote = yield* config.quoteAt(position.symbol, Date.parse(observedAt))
          if (metadata === undefined || !quoteUsable(quote, position.symbol, Date.parse(observedAt)))
            return yield* new ReplayBrokerFailure({
              message: `Replay position mark unavailable for ${position.symbol}`,
            })
          const price = yield* Effect.fromResult(numberToMicros(quote.value.bidPrice, 'mark.bid'))
          const value = yield* Effect.fromResult(notionalMicros(BigInt(position.quantityMicros), price))
          return {
            accountId,
            assetId: metadata.assetId,
            symbol: position.symbol,
            exchange: metadata.exchange,
            assetClass: AssetClass.UsEquity,
            side: PositionSide.Long,
            quantityMicros: position.quantityMicros,
            costBasisMicros: position.costBasisMicros,
            averageEntryPriceMicros: (
              (BigInt(position.costBasisMicros) * MICROS) /
              BigInt(position.quantityMicros)
            ).toString(),
            marketPriceMicros: price.toString(),
            marketValueMicros: value.toString(),
            unrealizedPnlMicros: (value - BigInt(position.costBasisMicros)).toString(),
            observedAt,
          } satisfies Position
        }),
      )
      return { positions, observedAt }
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
        return yield* evidence({ ...found.order, observedAt }, observedAt)
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof BrokerReadError ? cause : readFailure(operation, 'Replay order read failed', cause),
        ),
      )

    const read: BrokerReadShape = {
      account: Effect.gen(function* () {
        const current = yield* readState
        const { positions, observedAt } = yield* markedPositions
        const date = newYorkDate.format(Date.parse(observedAt))
        const previousSession = config.calendar
          .filter((session) => session.date < date)
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
                (query?.status === undefined ||
                  query.status === 'all' ||
                  (query.status === 'open' ? isOpen(order) : !isOpen(order))) &&
                (query?.symbols === undefined || query.symbols.includes(order.symbol)) &&
                (query?.side === undefined || query.side === order.side) &&
                (query?.after === undefined || order.createdAt > query.after) &&
                (query?.until === undefined || order.createdAt < query.until),
            )
            .toSorted((a, b) => (query?.direction === 'asc' ? 1 : -1) * a.createdAt.localeCompare(b.createdAt))
          return yield* evidence(
            orders.slice(0, query?.limit ?? 500).map((order) => ({ ...order, observedAt })),
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
            .filter(
              (fee) =>
                (query?.date === undefined || fee.date === query.date) &&
                (query?.after === undefined || fee.date >= query.after.slice(0, 10)) &&
                (query?.until === undefined || fee.date <= query.until.slice(0, 10)),
            )
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
      submit: (intent: Intent, closeOnly = false) =>
        Effect.gen(function* () {
          yield* readState
          const prepared = yield* Effect.fromResult(prepareSubmit(intent, accountId, closeOnly))
          const request = prepared.request
          if (request.type !== OrderType.Limit || request.time_in_force !== TimeInForce.ImmediateOrCancel)
            return yield* mutationFailure(MutationOperation.Submit, 'Replay requires the production LIMIT/IOC request')
          const observedAt = yield* now
          const metadata = asset(intent.symbol)
          if (metadata === undefined || !metadata.tradable)
            return yield* mutationFailure(MutationOperation.Submit, 'Captured asset is not tradable')
          const limit = yield* Effect.fromResult(decimalToMicrosResult(request.limit_price, false, 'limit price'))
          const brokerOrderId = simulatedUuid(
            yield* Effect.fromResult(hash({ runId: config.runId, clientOrderId: intent.clientOrderId })),
          )
          const pending: Order = {
            accountId,
            brokerOrderId,
            clientOrderId: intent.clientOrderId,
            createdAt: observedAt,
            updatedAt: observedAt,
            submittedAt: observedAt,
            assetId: metadata.assetId,
            symbol: intent.symbol,
            assetClass: AssetClass.UsEquity,
            quantityMicros: intent.quantityMicros,
            filledQuantityMicros: '0',
            orderClass: OrderClass.Simple,
            orderType: OrderType.Limit,
            side: request.side,
            timeInForce: TimeInForce.ImmediateOrCancel,
            limitPriceMicros: limit,
            status: OrderStatus.New,
            extendedHours: false,
            observedAt,
          }
          const existing = yield* SynchronizedRef.modify(state, (current) => {
            const previous = current.orders.find((entry) => entry.order.clientOrderId === intent.clientOrderId)
            return [
              previous,
              previous === undefined
                ? { ...current, orders: [...current.orders, { requestHash: prepared.requestHash, order: pending }] }
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
              const session = calendar.value.sessions.find((value) => value.date === sessionDate)
              const closeMs = session === undefined ? submittedAtMs : Date.parse(session.closeAt)
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
                session !== undefined && submittedAtMs >= Date.parse(session.openAt) && arrivedAtMs < closeMs
              const quote = sessionOpen ? yield* config.quoteAt(intent.symbol, arrivedAtMs) : undefined
              const valid = quoteUsable(quote, intent.symbol, arrivedAtMs)
              const outcome =
                valid && quote !== undefined
                  ? yield* Effect.fromResult(executeQuote(request.side, intent.quantityMicros, limit, quote.value))
                  : null
              const settle = (
                current: ReplayBrokerState,
              ): readonly [Result.Result<void, ReplayBrokerFailure>, ReplayBrokerState] => {
                const record = current.orders.find((entry) => entry.order.brokerOrderId === brokerOrderId)
                if (record === undefined || !isOpen(record.order)) return [Result.succeed(undefined), current] as const
                let nextLedger = current.ledger
                const fees = [...current.fees]
                const fills = [...current.fills]
                let order: Order = {
                  ...record.order,
                  observedAt: arrivedAt,
                  updatedAt: arrivedAt,
                  canceledAt: arrivedAt,
                  status: OrderStatus.Canceled,
                }
                if (outcome?.status === 'filled' && quote !== undefined) {
                  const applied = applyReplayFill(
                    current.ledger,
                    {
                      symbol: intent.symbol,
                      side: request.side,
                      observedAt: arrivedAt,
                      quantityMicros: outcome.filledQuantityMicros.toString(),
                      priceMicros: outcome.fillPriceMicros.toString(),
                      notionalMicros: outcome.fillNotionalMicros.toString(),
                      brokerOrderId,
                      clientOrderId: intent.clientOrderId,
                      quoteSource: {
                        topic: quote.value.sourceTopic,
                        partition: quote.value.sourcePartition,
                        offset: quote.value.sourceOffset,
                        availableAtMs: quote.availableAtMs,
                      },
                    },
                    intent.quantityMicros,
                    config.protocol.executionModel,
                    config.assumptions.feeMultiplierPpm,
                  )
                  if (Result.isFailure(applied)) {
                    if (
                      applied.failure._tag === 'IntradayReplayLedgerOversell' ||
                      applied.failure._tag === 'IntradayReplayLedgerInsufficientCash'
                    ) {
                      const rejected: Order = {
                        ...record.order,
                        status: OrderStatus.Rejected,
                        failedAt: arrivedAt,
                        updatedAt: arrivedAt,
                        observedAt: arrivedAt,
                      }
                      return [
                        Result.succeed(undefined),
                        {
                          ...current,
                          orders: current.orders.map((entry) =>
                            entry.order.brokerOrderId === brokerOrderId ? { ...entry, order: rejected } : entry,
                          ),
                        },
                      ]
                    }
                    return [
                      Result.fail(
                        new ReplayBrokerFailure({ message: 'Replay fill accounting failed', cause: applied.failure }),
                      ),
                      current,
                    ] as const
                  }
                  nextLedger = applied.success
                  const fee = BigInt(nextLedger.executionFeesMicros) - BigInt(current.ledger.executionFeesMicros)
                  if (fee !== 0n)
                    fees.push({
                      accountId,
                      activityId: `fee::${brokerOrderId}`,
                      date: arrivedAt.slice(0, 10),
                      netAmountMicros: (-fee).toString(),
                    })
                  const complete = outcome.unfilledRemainder === 'none'
                  order = {
                    ...record.order,
                    observedAt: arrivedAt,
                    updatedAt: arrivedAt,
                    filledAt: arrivedAt,
                    ...(complete ? {} : { canceledAt: arrivedAt }),
                    status: complete ? OrderStatus.Filled : OrderStatus.Canceled,
                    filledQuantityMicros: outcome.filledQuantityMicros.toString(),
                    filledAveragePriceMicros: outcome.fillPriceMicros.toString(),
                  }
                  fills.push({
                    accountId,
                    activityId: `fill::${brokerOrderId}`,
                    cumulativeQuantityMicros: order.filledQuantityMicros,
                    leavesQuantityMicros: (BigInt(intent.quantityMicros) - outcome.filledQuantityMicros).toString(),
                    priceMicros: outcome.fillPriceMicros.toString(),
                    quantityMicros: order.filledQuantityMicros,
                    side: request.side,
                    symbol: intent.symbol,
                    transactionTime: arrivedAt,
                    brokerOrderId,
                    type: complete ? TradeActivityType.Fill : TradeActivityType.PartialFill,
                    orderStatus: order.status,
                  })
                }
                return [
                  Result.succeed(undefined),
                  {
                    ...current,
                    ledger: nextLedger,
                    fees,
                    fills,
                    orders: current.orders.map((entry) =>
                      entry.order.brokerOrderId === brokerOrderId ? { ...entry, order } : entry,
                    ),
                  },
                ] as const
              }
              const settled = yield* SynchronizedRef.modifyEffect(state, (current) =>
                Effect.succeed(settle(current)).pipe(
                  Effect.tap(([result, next]) =>
                    Result.isFailure(result) || config.retainSettlement === undefined
                      ? Effect.void
                      : Effect.fromResult(makeReplayBrokerCheckpoint(config, next, arrivedAt)).pipe(
                          Effect.flatMap(config.retainSettlement),
                          Effect.tapCause((cause) =>
                            Ref.set(
                              retentionFailure,
                              new ReplayBrokerFailure({
                                message:
                                  'Broker settlement persistence failed; restore durable state before further reads or mutations',
                                cause: Cause.squash(cause),
                              }),
                            ),
                          ),
                        ),
                  ),
                ),
              )
              yield* Effect.fromResult(settled)
            }).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.gen(function* () {
                      const failedAt = yield* now
                      yield* SynchronizedRef.update(state, (current) => ({
                        ...current,
                        orders: current.orders.map((entry) =>
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
          yield* SynchronizedRef.update(state, (current) => ({
            ...current,
            orders: current.orders.map((entry) =>
              entry.order.brokerOrderId === brokerOrderId && isOpen(entry.order)
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
          const receipt = yield* evidence({ brokerOrderId, canceledAt: observedAt }, observedAt)
          return { requestHash: prepared.requestHash, brokerOrderId, evidence: receipt.evidence }
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
    const completeSession = (sessionDate: string) =>
      Effect.gen(function* () {
        const calendar = yield* read.marketCalendar({ start: sessionDate, end: sessionDate })
        const session = calendar.value.sessions.find((value) => value.date === sessionDate)
        const observedAtMs = yield* Clock.currentTimeMillis
        if (session === undefined || Date.parse(session.closeAt) !== observedAtMs)
          return yield* new ReplayBrokerFailure({
            message: 'Session equity must be captured at the recorded market close',
          })
        const current = yield* readState
        if (current.orders.some((record) => isOpen(record.order)))
          return yield* new ReplayBrokerFailure({ message: 'Cannot complete session with unresolved broker orders' })
        const account = yield* read.account
        const close = { sessionDate, equityMicros: account.value.equityMicros }
        const previous = current.sessionCloses.find((value) => value.sessionDate === sessionDate)
        if (previous !== undefined && previous.equityMicros !== close.equityMicros)
          return yield* new ReplayBrokerFailure({ message: 'Session close changed after it was recorded' })
        if (previous === undefined)
          yield* SynchronizedRef.update(state, (value) => ({
            ...value,
            sessionCloses: [...value.sessionCloses, close],
          }))
        return close
      })
    const checkpoint = Effect.gen(function* () {
      const observedAt = yield* now
      return yield* Effect.fromResult(makeReplayBrokerCheckpoint(config, yield* readState, observedAt))
    })
    return {
      accountId,
      sourceManifestHash: config.sourceManifestHash,
      read,
      mutation,
      completeSession,
      snapshot: readState,
      checkpoint,
    }
  })
