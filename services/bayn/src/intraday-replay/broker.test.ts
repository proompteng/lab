import { equityMarketProfile } from '../jev/markets'

import { expect, test } from 'bun:test'
import { Clock, Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import {
  AssetClass,
  AssetExchange,
  AssetStatus,
  OrderCollection,
  OrderSide as BrokerOrderSide,
  OrderStatus,
  OrderType as BrokerOrderType,
  SortDirection,
  TimeInForce as BrokerTimeInForce,
} from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { prepareAccounting } from '../accounting/domain'
import { IntentState, OrderSide, OrderType, TimeInForce, type Intent } from '../execution/contracts'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { canonicalHashV1Result } from '../hash'
import type { IntradayQuote } from '../market-data/intraday/model'
import { makeReplayBroker, ReplayBrokerFailure, type ReplayBrokerConfig } from './broker'
import { fillObservation, positionSnapshot } from '../broker/observations'
import { restoreReplayBrokerCheckpoint, type ReplayBrokerCheckpoint } from './broker-checkpoint'
import { ReplayQuoteRejection } from './broker-execution-evidence'
import { makeReplayJevTiming } from './jev-timing'
import {
  emptyStreamingProjection,
  incorporateRecordedMarketValue,
  observedQuoteAt,
} from '../market-data/streaming/projection'

const runId = 'a'.repeat(64)
const observedAt = '2026-09-04T14:31:00.000Z'
const startMs = Date.parse(observedAt)
const { protocol, snapshot } = streamingFixture()
const originalQuote = snapshot.quotes.find((value) => value.symbol === 'AAPL')
if (originalQuote === undefined) throw new Error('Missing quote fixture')
const quote = {
  ...originalQuote,
  eventAt: observedAt,
  ingestedAt: observedAt,
  bidPrice: 100,
  askPrice: 100,
  bidSize: 100,
  askSize: 100,
}
const observedQuote = (value: IntradayQuote, availableAtMs = startMs) => ({
  value,
  availableAtMs,
  sequence: 1,
  recordHash: Result.getOrThrow(canonicalHashV1Result(value)),
})
const config: ReplayBrokerConfig = {
  runId,
  sourceManifestHash: 'c'.repeat(64),
  protocol,
  openingCashMicros: '10000000000',
  assumptions: { latencyMs: 100, slippageBps: 0, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 },
  fractionalTrading: false,
  calendar: [{ session_open: '0930', session_close: '1600', date: '2026-09-04', open: '09:30', close: '16:00' }],
  assets: [
    Result.getOrThrow(
      normalizeAssetResult(
        {
          id: '12345678-1234-4234-8234-123456789abc',
          symbol: 'AAPL',
          class: AssetClass.UsEquity,
          exchange: AssetExchange.Nasdaq,
          status: AssetStatus.Active,
          tradable: true,
          fractionable: true,
        },
        'AAPL',
        observedAt,
      ),
    ),
  ],
  quoteAt: () => Effect.succeed(observedQuote(quote)),
}
const intent = (overrides: Partial<Intent> = {}): Intent => ({
  schemaVersion: 'bayn.execution-intent.v5',
  intentId: '1'.repeat(64),
  riskDecisionId: '6'.repeat(64),
  authorityGenerationHash: '2'.repeat(64),
  cycleId: '3'.repeat(64),
  decisionHash: '4'.repeat(64),
  policyHash: '5'.repeat(64),
  strategyName: 'intraday-momentum',
  accountId: `replay-${runId}`,
  clientOrderId: 'replay-buy-1',
  symbol: 'AAPL',
  side: OrderSide.Buy,
  orderType: OrderType.Limit,
  timeInForce: TimeInForce.Day,
  quantityAtoms: '5000000000',
  notionalLimitMicros: '505000000',
  limitPriceMicros: '101000000',
  state: IntentState.IoStarted,
  createdAt: observedAt,
  ...overrides,
})
const setup = (overrides: Partial<ReplayBrokerConfig> = {}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMs)
    return yield* makeReplayBroker({ ...config, ...overrides })
  })
type Broker = Effect.Success<ReturnType<typeof setup>>
const submit = (broker: Broker, order: Intent) =>
  Effect.gen(function* () {
    const pending = yield* broker.mutation.submit(order).pipe(Effect.forkChild({ startImmediately: true }))
    yield* TestClock.adjust(100)
    return yield* Fiber.join(pending)
  })
const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(TestClock.layer())))

test('an equity-only replay account leaves crypto eligibility unknown', async () => {
  const account = await run(setup().pipe(Effect.flatMap((broker) => broker.read.account)))
  expect(account.value.cryptoStatus).toBeNull()
  expect(account.value.nonMarginableBuyingPowerMicros).toBeNull()
})

test('same-millisecond round trips preserve fill accounting order across checkpoint restore', async () => {
  await run(
    Effect.gen(function* () {
      const frozen = { ...config, assumptions: { ...config.assumptions, latencyMs: 0 } }
      let broker = yield* setup(frozen)
      yield* broker.mutation.submit(intent())
      const bought = yield* broker.checkpoint
      broker = yield* makeReplayBroker({
        ...frozen,
        restoreCheckpoint: { value: bought, expectedHash: bought.checkpointHash },
      })
      yield* broker.mutation.submit(
        intent({
          clientOrderId: 'same-millisecond-sell',
          side: OrderSide.Sell,
          limitPriceMicros: '99000000',
          notionalLimitMicros: '495000000',
        }),
      )
      const flat = yield* broker.checkpoint
      expect(flat.state.ledger.positions).toEqual([])
      expect(flat.state.fills.map((fill) => fill.transactionTime)).toEqual([observedAt, observedAt])
      expect(
        [...flat.state.fills].sort((a, b) => a.activityId.localeCompare(b.activityId)).map((fill) => fill.side),
      ).toEqual([BrokerOrderSide.Buy, BrokerOrderSide.Sell])
      const activities = yield* broker.read.fillActivities({ direction: SortDirection.Ascending })
      const orders = yield* broker.read.orders()
      let position = { quantityAtoms: '0', costMicros: '0' }
      for (const activity of activities.value.items) {
        const order = orders.value.find((value) => value.brokerOrderId === activity.brokerOrderId)
        if (order === undefined) throw new Error('Fill order is missing')
        const observation = Result.getOrThrow(fillObservation(activity, order, activities.evidence))
        const prepared = Result.getOrThrow(prepareAccounting(observation.contentHash, observation.fill, position, 1))
        position = {
          quantityAtoms: (BigInt(position.quantityAtoms) + BigInt(prepared.transaction.quantityDeltaAtoms)).toString(),
          costMicros: (BigInt(position.costMicros) + BigInt(prepared.transaction.costBasisDeltaMicros)).toString(),
        }
      }
      expect(position).toEqual({ quantityAtoms: '0', costMicros: '0' })
      const restored = yield* makeReplayBroker({
        ...frozen,
        restoreCheckpoint: { value: flat, expectedHash: flat.checkpointHash },
      })
      expect((yield* restored.snapshot).fills).toEqual(flat.state.fills)
    }),
  )
})

test('an equity DAY order remains open when its first arrival cannot fill', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ assumptions: { ...config.assumptions, slippageBps: 1 } })
      const submitted = yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('500000000') * 1000000000n) / BigInt('5000000000')).toString(),
          notionalLimitMicros: '500000000',
        }),
      )
      return { submitted, open: (yield* broker.read.orders({ status: OrderCollection.Open })).value }
    }),
  )
  expect(result.submitted.order.status).toBe(OrderStatus.New)
  expect(result.submitted.order.filledQuantityAtoms).toBe('0')
  expect(result.open.map((order) => order.brokerOrderId)).toEqual([result.submitted.order.brokerOrderId])
})

test('a DAY order captures a later brief crossing before the next account poll', async () => {
  const state = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ assumptions: { ...config.assumptions, slippageBps: 1 } })
      yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('500000000') * 1000000000n) / BigInt('5000000000')).toString(),
          notionalLimitMicros: '500000000',
        }),
      )
      for (const [delay, price, offset] of [
        [1_000, 99, '2'],
        [1_100, 101, '3'],
      ] as const) {
        const at = startMs + delay
        yield* broker.observeMarket(
          at,
          observedQuote(
            {
              ...quote,
              eventAt: new Date(at).toISOString(),
              ingestedAt: new Date(at).toISOString(),
              bidPrice: price,
              askPrice: price,
              sourceOffset: offset,
            },
            at,
          ),
        )
      }
      yield* TestClock.setTime(startMs + 2_000)
      return yield* broker.snapshot
    }),
  )
  expect(state.orders[0]?.order.status).toBe(OrderStatus.Filled)
  expect(state.ledger.fills).toHaveLength(1)
  expect(state.ledger.fills[0]?.observedAt).toBe('2026-09-04T14:31:01.000Z')
  expect(state.ledger.fills[0]?.priceMicros).toBe('99010000')
})

test('a partial DAY order resumes after restart and retains each fill and fee activity', async () => {
  const laterAt = startMs + 1_000
  const firstQuote = observedQuote({ ...quote, askSize: 2 })
  const laterQuote = observedQuote(
    {
      ...quote,
      eventAt: new Date(laterAt).toISOString(),
      ingestedAt: new Date(laterAt).toISOString(),
      bidPrice: 100.5,
      askPrice: 100.5,
      sourceOffset: '2',
    },
    laterAt,
  )
  const quoteAt: ReplayBrokerConfig['quoteAt'] = (_symbol, at) => Effect.succeed(at < laterAt ? firstQuote : laterQuote)
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ quoteAt })
      const first = yield* submit(broker, intent())
      const checkpoint = yield* broker.checkpoint
      const restored = yield* makeReplayBroker({
        ...config,
        quoteAt,
        restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
      })
      yield* restored.observeMarket(laterAt, laterQuote)
      yield* TestClock.setTime(laterAt)
      const completed = yield* restored.checkpoint
      const secondRestore = yield* makeReplayBroker({
        ...config,
        quoteAt,
        restoreCheckpoint: { value: completed, expectedHash: completed.checkpointHash },
      })
      yield* secondRestore.observeMarket(laterAt, laterQuote)
      return { first, state: yield* restored.snapshot, recovered: yield* secondRestore.snapshot }
    }),
  )
  expect(result.first.order.status).toBe(OrderStatus.PartiallyFilled)
  expect(result.first.order.filledQuantityAtoms).toBe('2000000000')
  expect(result.state.orders[0]?.order.status).toBe(OrderStatus.Filled)
  expect(result.state.orders[0]?.order.filledAveragePriceMicros).toBe('100300000')
  expect(result.state.fills.map((fill) => fill.quantityAtoms)).toEqual(['2000000000', '3000000000'])
  expect(result.state.fills.map((fill) => fill.cumulativeQuantityAtoms)).toEqual(['2000000000', '5000000000'])
  expect(new Set(result.state.fills.map((fill) => fill.activityId)).size).toBe(2)
  expect(result.recovered).toEqual(result.state)
})

test('DAY recovery retains distinct fills from quotes available in the same millisecond', async () => {
  const universe = {
    universeId: equityMarketProfile.universeId,
    universeSymbolHash: equityMarketProfile.universeSymbolHash,
    symbols: equityMarketProfile.universe,
    topics: { ...equityMarketProfile.sourceTopics, features: 'torghut.market-features.v1' },
  }
  await run(
    Effect.gen(function* () {
      let projection = incorporateRecordedMarketValue(
        emptyStreamingProjection('equal-time-day-fills'),
        { ...quote, askSize: 0 },
        universe,
        startMs,
      )
      const quoteAt: ReplayBrokerConfig['quoteAt'] = (symbol, atMs, source) =>
        Effect.sync(() => observedQuoteAt(projection, symbol, atMs, source))
      const broker = yield* setup({ quoteAt })
      yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('303000000') * 1000000000n) / BigInt('3000000000')).toString(),
          quantityAtoms: '3000000000',
          notionalLimitMicros: '303000000',
        }),
      )
      const atMs = startMs + 1_000
      yield* TestClock.setTime(atMs)
      for (const [index, price] of [99, 100].entries()) {
        projection = incorporateRecordedMarketValue(
          projection,
          {
            ...quote,
            sourceOffset: String(BigInt(quote.sourceOffset) + BigInt(index + 1)),
            eventAt: new Date(atMs).toISOString(),
            ingestedAt: new Date(atMs).toISOString(),
            bidPrice: price,
            askPrice: price,
            askSize: 1,
          },
          universe,
          atMs,
        )
        const incoming = projection.quotes.get('AAPL')
        if (incoming === undefined) throw new Error('Missing accepted equal-time quote')
        yield* broker.observeMarket(atMs, incoming)
      }
      const checkpoint = yield* broker.checkpoint
      expect(checkpoint.state.orders[0]?.order.status).toBe(OrderStatus.PartiallyFilled)
      expect(checkpoint.state.ledger.fills.map((fill) => fill.observedAt)).toEqual([
        new Date(atMs).toISOString(),
        new Date(atMs).toISOString(),
      ])
      expect(new Set(checkpoint.state.ledger.fills.map((fill) => fill.quoteSource.offset)).size).toBe(2)
      const restored = yield* makeReplayBroker({
        ...config,
        quoteAt,
        restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
      })
      expect(yield* restored.snapshot).toEqual(yield* broker.snapshot)
      const current = projection.quotes.get('AAPL')
      if (current === undefined) throw new Error('Missing accepted equal-time quote')
      yield* restored.observeMarket(atMs, current)
      expect(yield* restored.snapshot).toEqual(yield* broker.snapshot)
    }),
  )
})

test('canceling a resting DAY order prevents execution on subsequent quotes', async () => {
  const state = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ assumptions: { ...config.assumptions, slippageBps: 1 } })
      const submitted = yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('500000000') * 1000000000n) / BigInt('5000000000')).toString(),
          notionalLimitMicros: '500000000',
        }),
      )
      const canceled = yield* broker.mutation.cancel(submitted.order.brokerOrderId)
      expect(canceled.evidence.status).toBe(204)
      expect(canceled.evidence.contentHash).toBe(Result.getOrThrow(canonicalHashV1Result(null)))
      const at = startMs + 1_000
      yield* broker.observeMarket(
        at,
        observedQuote(
          {
            ...quote,
            eventAt: new Date(at).toISOString(),
            ingestedAt: new Date(at).toISOString(),
            bidPrice: 99,
            askPrice: 99,
            sourceOffset: '2',
          },
          at,
        ),
      )
      yield* TestClock.setTime(at)
      return yield* broker.snapshot
    }),
  )
  expect(state.orders[0]?.order.status).toBe(OrderStatus.Canceled)
  expect(state.ledger.fills).toEqual([])
})

test('an extended-hours DAY order expires at the broker session end, including without another quote', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        assumptions: { ...config.assumptions, slippageBps: 1 },
        calendar: [
          {
            ...config.calendar[0],
            date: '2026-09-04',
            open: '09:30',
            close: '16:00',
            session_open: '0400',
            session_close: '2000',
          },
        ],
      })
      const submitted = yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('500000000') * 1000000000n) / BigInt('5000000000')).toString(),
          notionalLimitMicros: '500000000',
        }),
      )
      yield* TestClock.setTime(Date.parse('2026-09-04T21:00:00.000Z'))
      const afterData = yield* broker.read.orderById(submitted.order.brokerOrderId)
      yield* TestClock.setTime(Date.parse('2026-09-05T00:00:00.000Z'))
      const expired = yield* broker.read.orderById(submitted.order.brokerOrderId)
      return { afterData, expired, state: yield* broker.snapshot }
    }),
  )
  expect(result.afterData.value.status).toBe(OrderStatus.New)
  expect(result.expired.value.status).toBe(OrderStatus.Expired)
  expect(result.expired.value.updatedAt).toBe('2026-09-05T00:00:00.000Z')
  expect(result.state.ledger.fills).toEqual([])
})

test('an unfilled DAY evaluation retains the actual arrival quote, modeled price and reason in its durable checkpoint', async () => {
  const checkpoint = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ assumptions: { ...config.assumptions, slippageBps: 1 } })
      yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('500000000') * 1000000000n) / BigInt('5000000000')).toString(),
          notionalLimitMicros: '500000000',
        }),
      )
      return yield* broker.checkpoint
    }),
  )
  expect(checkpoint.state.orders[0]?.executions.at(-1)).toMatchObject({
    arrivedAt: '2026-09-04T14:31:00.100Z',
    quote: {
      eventAt: observedAt,
      availableAtMs: startMs,
      ageNanos: '100000000',
      askPrice: 100,
      askSize: 100,
      sourceOffset: quote.sourceOffset,
    },
    outcome: { status: 'unfilled', reason: 'adverse-price-exceeds-limit', adversePriceMicros: '100010000' },
  })
  expect(checkpoint.state.orders[0]?.order.filledQuantityAtoms).toBe('0')
})

test('checkpoint restore rejects a rehashed change to native duration or extended hours', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      yield* submit(broker, intent())
      const checkpoint = yield* broker.checkpoint
      const { checkpointHash: _, ...material } = checkpoint
      for (const changed of [{ timeInForce: BrokerTimeInForce.ImmediateOrCancel }, { extendedHours: false }]) {
        const forgedMaterial = {
          ...material,
          state: {
            ...material.state,
            orders: material.state.orders.map((value) => ({
              ...value,
              order: { ...value.order, ...changed },
            })),
          },
        }
        const forged = { ...forgedMaterial, checkpointHash: Result.getOrThrow(canonicalHashV1Result(forgedMaterial)) }
        expect(Result.isFailure(restoreReplayBrokerCheckpoint(forged, config))).toBe(true)
      }
    }),
  )
})

test('historical arrival scheduler advances data before delivery without a wall-time polling loop', async () => {
  const arrivals: number[] = []
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        advanceToArrival: (atMs) =>
          Effect.sync(() => {
            arrivals.push(atMs)
          }).pipe(Effect.andThen(TestClock.setTime(atMs))),
        quoteAt: (_symbol, atMs) =>
          Effect.succeed(observedQuote({ ...quote, askPrice: arrivals.includes(atMs) ? 100.5 : 100 })),
      })
      const filled = yield* broker.mutation.submit(intent())
      yield* broker.mutation.submit(intent())
      return filled
    }),
  )
  expect(arrivals).toEqual([startMs + 100])
  expect(result.order.filledAveragePriceMicros).toBe('100500000')
  expect(result.order.filledAt).toBe('2026-09-04T14:31:00.100Z')
})

test.each([0, 100])(
  'replay parsing cannot expose future quotes while %sms persistence delay remains measured',
  async (persistenceMs) => {
    const result = await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(startMs)
        const providerClock = yield* TestClock.make()
        yield* providerClock.setTime(0)
        let excludedSourceMillis = 0
        const timing = yield* makeReplayJevTiming({
          measureDatabaseTime: (operation) => operation,
          provider: { evaluate: () => Effect.die('This timing case does not need inference') },
          providerClock,
          retain: () => Effect.void,
          advanceTo: (at) =>
            TestClock.setTime(at).pipe(
              Effect.andThen(providerClock.adjust(5000)),
              Effect.tap(() =>
                Effect.sync(() => {
                  excludedSourceMillis += 5000
                }),
              ),
            ),
          advanceDeadlineTo: (at) => TestClock.setTime(at),
          excludedSourceMillis: Effect.sync(() => excludedSourceMillis),
        })
        let lastArrival = startMs
        const broker = yield* setup({
          submissionTime: timing.currentUtcInstant,
          assumptions: { ...config.assumptions, latencyMs: 10 },
          advanceToArrival: (at) =>
            Effect.sync(() => {
              lastArrival = at
            }).pipe(Effect.andThen(TestClock.setTime(at))),
          quoteAt: (_symbol, at) =>
            Effect.succeed(
              observedQuote(
                { ...quote, askPrice: at >= startMs + 100 ? 100.5 : 100 },
                at >= startMs + 100 ? startMs + 100 : startMs,
              ),
            ),
        })
        const completed = yield* timing.run(
          Effect.gen(function* () {
            const authorizedAt = yield* timing.currentUtcInstant
            yield* providerClock.adjust(persistenceMs)
            const submitted = yield* broker.mutation.submit(intent())
            return { authorizedAt, order: submitted.order, checkpoint: yield* broker.checkpoint, lastArrival }
          }),
        )
        return { ...completed, marketAfter: yield* Clock.currentTimeMillis }
      }),
    )
    const submittedAt = result.order.submittedAt
    if (submittedAt === undefined) throw new Error('Measured replay order is missing its submission time')
    expect(Date.parse(result.authorizedAt)).toBe(startMs)
    expect(Date.parse(submittedAt)).toBeGreaterThanOrEqual(Date.parse(result.authorizedAt))
    expect(Date.parse(submittedAt)).toBe(startMs + persistenceMs)
    expect(result.lastArrival).toBe(Date.parse(submittedAt) + 10)
    expect(result.marketAfter).toBe(result.lastArrival)
    expect(result.order.filledAveragePriceMicros).toBe(persistenceMs === 0 ? '100000000' : '100500000')
    expect(result.checkpoint.state.orders[0]?.executions.at(-1)?.quote?.availableAtMs).toBe(startMs + persistenceMs)
  },
)

test('an unavailable measured submission clock cannot create a replay order or fill', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        submissionTime: Effect.fail(new ReplayBrokerFailure({ message: 'Measured clock unavailable' })),
        advanceToArrival: (at) => TestClock.setTime(at),
      })
      const submitted = yield* broker.mutation.submit(intent()).pipe(Effect.exit)
      return { submitted, state: yield* broker.snapshot }
    }),
  )
  expect(Exit.isFailure(result.submitted)).toBe(true)
  expect(result.state.orders).toEqual([])
  expect(result.state.fills).toEqual([])
})

test('an inaccurate historical scheduler cannot manufacture a fill', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ advanceToArrival: (atMs) => TestClock.setTime(atMs + 1) })
      const submitted = yield* Effect.exit(broker.mutation.submit(intent()))
      return { submitted, state: yield* broker.snapshot }
    }),
  )
  expect(Exit.isFailure(result.submitted)).toBe(true)
  expect(result.state.fills).toEqual([])
  expect(result.state.orders[0]?.order.status).toBe(OrderStatus.Canceled)
})

test('arrival quote drives partial DAY fill and the remainder stays active', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        quoteAt: (_symbol, time) =>
          Effect.succeed(observedQuote({ ...quote, askPrice: time >= startMs + 100 ? 100.5 : 100, askSize: 2 })),
      })
      const filled = yield* submit(broker, intent())
      const duplicate = yield* broker.mutation.submit(intent())
      const conflict = yield* Effect.result(
        broker.mutation.submit(
          intent({
            limitPriceMicros: ((BigInt('510000000') * 1000000000n) / BigInt('5000000000')).toString(),
            notionalLimitMicros: '510000000',
          }),
        ),
      )
      return {
        filled,
        duplicate,
        conflict,
        state: yield* broker.snapshot,
        positions: (yield* broker.read.positions).value,
        account: (yield* broker.read.account).value,
        fills: (yield* broker.read.fillActivities()).value,
      }
    }),
  )
  expect(result.filled.order.status).toBe(OrderStatus.PartiallyFilled)
  expect(result.filled.order.filledQuantityAtoms).toBe('2000000000')
  expect(result.filled.order.filledAveragePriceMicros).toBe('100500000')
  expect(result.duplicate.order.brokerOrderId).toBe(result.filled.order.brokerOrderId)
  expect(Result.isFailure(result.conflict)).toBe(true)
  expect(result.state.ledger.fills).toHaveLength(1)
  expect(result.fills.items).toHaveLength(1)
  expect(result.positions[0]?.quantityAtoms).toBe('2000000000')
  expect(result.account.cashMicros).toBe(result.state.ledger.cashMicros)
  expect(result.state.ledger.fills[0]?.quoteSource.offset).toBe(quote.sourceOffset)
  expect(result.state.orders[0]?.executions.at(-1)?.outcome).toMatchObject({
    status: 'filled',
    filledQuantityAtoms: '2000000000',
    fillPriceMicros: '100500000',
    remainingQuantityAtoms: '3000000000',
  })
})

test.each([
  { first: '1000000000', second: '2000000000', expectedSecond: '1000000000', askSize: 2, liquidityPpm: 1_000_000 },
  { first: '2000000000', second: '1000000000', expectedSecond: '0', askSize: 2, liquidityPpm: 1_000_000 },
  { first: '1000000000', second: '2000000000', expectedSecond: '1000000000', askSize: 4, liquidityPpm: 500_000 },
])(
  'repeated limit orders consume one quote only once: %o',
  async ({ first, second, expectedSecond, askSize, liquidityPpm }) => {
    const result = await run(
      Effect.gen(function* () {
        const thinQuote = observedQuote({ ...quote, askSize })
        const assumptions = { ...config.assumptions, availableLiquidityPpm: liquidityPpm }
        const broker = yield* setup({ quoteAt: () => Effect.succeed(thinQuote), assumptions })
        yield* submit(
          broker,
          intent({
            limitPriceMicros: ((BigInt('505000000') * 1000000000n) / BigInt(first)).toString(),
            quantityAtoms: first,
          }),
        )
        const later = yield* submit(
          broker,
          intent({
            limitPriceMicros: ((BigInt('505000000') * 1000000000n) / BigInt(second)).toString(),
            intentId: '7'.repeat(64),
            clientOrderId: 'replay-buy-2',
            quantityAtoms: second,
          }),
        )
        const checkpoint = yield* broker.checkpoint
        const restored = yield* makeReplayBroker({
          ...config,
          quoteAt: () => Effect.succeed(thinQuote),
          assumptions,
          restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
        })
        return { later, state: yield* broker.snapshot, restored: yield* restored.snapshot }
      }),
    )
    expect(result.later.order.filledQuantityAtoms).toBe(expectedSecond)
    expect(result.state.ledger.positions[0]?.quantityAtoms).toBe('2000000000')
    expect(result.restored.ledger).toEqual(result.state.ledger)
  },
)

test('a later quote and the opposite side each have their own displayed-liquidity budget', async () => {
  const result = await run(
    Effect.gen(function* () {
      const thinQuote = { ...quote, askSize: 2, bidSize: 2 }
      const broker = yield* setup({
        quoteAt: (_symbol, atMs) =>
          Effect.succeed(observedQuote(atMs >= startMs + 200 ? { ...thinQuote, sourceOffset: '2' } : thinQuote)),
      })
      yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('505000000') * 1000000000n) / BigInt('2000000000')).toString(),
          quantityAtoms: '2000000000',
        }),
      )
      const laterBuy = yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('505000000') * 1000000000n) / BigInt('1000000000')).toString(),
          intentId: '7'.repeat(64),
          clientOrderId: 'replay-buy-2',
          quantityAtoms: '1000000000',
        }),
      )
      const sell = yield* submit(
        broker,
        intent({
          limitPriceMicros: (
            (BigInt('200000000') * 1000000000n + BigInt('2000000000') - 1n) /
            BigInt('2000000000')
          ).toString(),

          intentId: '8'.repeat(64),
          clientOrderId: 'replay-sell-1',
          side: OrderSide.Sell,
          quantityAtoms: '2000000000',
          notionalLimitMicros: '200000000',
        }),
      )
      return { laterBuy, sell, state: yield* broker.snapshot }
    }),
  )
  expect(result.laterBuy.order.filledQuantityAtoms).toBe('1000000000')
  expect(result.sell.order.filledQuantityAtoms).toBe('2000000000')
  expect(result.state.ledger.positions[0]?.quantityAtoms).toBe('1000000000')
})

test('simultaneous deliveries cannot spend the same quote budget twice', async () => {
  const state = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ quoteAt: () => Effect.succeed(observedQuote({ ...quote, askSize: 2 })) })
      const first = yield* broker.mutation
        .submit(
          intent({
            limitPriceMicros: ((BigInt('505000000') * 1000000000n) / BigInt('2000000000')).toString(),
            quantityAtoms: '2000000000',
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }))
      const second = yield* broker.mutation
        .submit(
          intent({
            limitPriceMicros: ((BigInt('505000000') * 1000000000n) / BigInt('2000000000')).toString(),
            intentId: '7'.repeat(64),
            clientOrderId: 'replay-buy-2',
            quantityAtoms: '2000000000',
          }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(100)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      return yield* broker.snapshot
    }),
  )
  expect(state.ledger.fills.reduce((total, fill) => total + BigInt(fill.quantityAtoms), 0n)).toBe(2000000000n)
  expect(state.orders).toHaveLength(2)
})

test('round trip cash includes execution fees and broker activities agree with fills', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        quoteAt: (_symbol, time) =>
          Effect.succeed(
            observedQuote({
              ...quote,
              bidPrice: time >= startMs + 200 ? 101 : 100,
              askPrice: time >= startMs + 200 ? 101 : 100,
            }),
          ),
      })
      yield* submit(broker, intent())
      yield* submit(
        broker,
        intent({
          limitPriceMicros: (
            (BigInt('500000000') * 1000000000n + BigInt('5000000000') - 1n) /
            BigInt('5000000000')
          ).toString(),
          clientOrderId: 'replay-sell-1',
          side: OrderSide.Sell,
          notionalLimitMicros: '500000000',
        }),
      )
      return {
        state: yield* broker.snapshot,
        account: (yield* broker.read.account).value,
        positions: (yield* broker.read.positions).value,
        fees: (yield* broker.read.feeActivities()).value,
      }
    }),
  )
  expect(result.positions).toEqual([])
  expect(result.state.ledger.fills).toHaveLength(2)
  expect(result.state.ledger.netRealizedPnlAfterCostsMicros).toBe(
    (5_000_000n - BigInt(result.state.ledger.executionFeesMicros)).toString(),
  )
  expect(result.account.equityMicros).toBe(result.state.ledger.cashMicros)
  expect(result.fees.items.reduce((total, fee) => total + BigInt(fee.netAmountMicros), 0n)).toBe(
    -BigInt(result.state.ledger.executionFeesMicros),
  )
})

test('cancel during order latency prevents any fill', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      const pending = yield* broker.mutation.submit(intent()).pipe(Effect.forkChild({ startImmediately: true }))
      const open = (yield* broker.read.orders({ status: OrderCollection.Open })).value[0]
      if (open === undefined) return yield* Effect.die(new Error('Pending order missing'))
      yield* broker.mutation.cancel(open.brokerOrderId)
      yield* TestClock.adjust(100)
      return { receipt: yield* Fiber.join(pending), state: yield* broker.snapshot }
    }),
  )
  expect(result.receipt.order.status).toBe(OrderStatus.Canceled)
  expect(result.state.ledger.fills).toEqual([])
  expect(result.state.ledger.cashMicros).toBe(config.openingCashMicros)
})

test('lost submit response does not cancel an accepted broker order', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      const request = yield* broker.mutation.submit(intent()).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(10)
      yield* Fiber.interrupt(request)
      yield* TestClock.adjust(90)
      return {
        order: (yield* broker.read.orderByClientId(intent().clientOrderId)).value,
        state: yield* broker.snapshot,
      }
    }),
  )
  expect(result.order.status).toBe(OrderStatus.Filled)
  expect(result.state.ledger.fills).toHaveLength(1)
})

test.each(['stale', 'future', 'crossed', 'zero-bid', 'zero-ask', 'other-feed'] as const)(
  '%s quote cannot fill an order',
  async (kind) => {
    const result = await run(
      Effect.gen(function* () {
        const broker = yield* setup({
          quoteAt: () =>
            Effect.succeed(
              observedQuote(
                {
                  ...quote,
                  eventAt: kind === 'stale' ? '2026-09-04T14:30:00.000Z' : observedAt,
                  bidPrice: kind === 'crossed' ? 102 : kind === 'zero-bid' ? 0 : 100,
                  bidSize: kind === 'zero-bid' ? 0 : quote.bidSize,
                  askPrice: kind === 'zero-ask' ? 0 : quote.askPrice,
                  askSize: kind === 'zero-ask' ? 0 : quote.askSize,
                  feed: kind === 'other-feed' ? 'sip' : 'iex',
                },
                kind === 'future' ? startMs + 1000 : startMs,
              ),
            ),
        })
        const receipt = yield* submit(broker, intent())
        return { receipt, checkpoint: yield* broker.checkpoint }
      }),
    )
    expect(result.receipt.order.status).toBe(OrderStatus.New)
    expect(result.receipt.order.filledQuantityAtoms).toBe('0')
    const reasons = {
      stale: ReplayQuoteRejection.Stale,
      future: ReplayQuoteRejection.Unavailable,
      crossed: ReplayQuoteRejection.Price,
      'zero-bid': ReplayQuoteRejection.Price,
      'zero-ask': ReplayQuoteRejection.Price,
      'other-feed': ReplayQuoteRejection.Identity,
    }
    expect(result.checkpoint.state.orders[0]?.executions.at(-1)?.outcome).toEqual({
      status: 'unfilled',
      reason: reasons[kind],
      adversePriceMicros: null,
    })
  },
)

test.each(['oversell', 'cash'] as const)('%s rejection is terminal and recoverable by client ID', async (kind) => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ openingCashMicros: kind === 'cash' ? '1000000' : config.openingCashMicros })
      const order = intent({
        limitPriceMicros: ((BigInt('500000000') * 1000000000n) / BigInt('5000000000')).toString(),

        side: kind === 'oversell' ? OrderSide.Sell : OrderSide.Buy,
        notionalLimitMicros: '500000000',
      })
      const receipt = yield* submit(broker, order)
      return { receipt, lookup: yield* broker.read.orderByClientId(order.clientOrderId), state: yield* broker.snapshot }
    }),
  )
  expect(result.receipt.order.status).toBe(OrderStatus.Rejected)
  expect(result.lookup.value.status).toBe(OrderStatus.Rejected)
  expect(result.state.ledger.fills).toEqual([])
  expect(result.state.orders[0]?.executions.at(-1)?.outcome).toEqual({
    status: 'rejected',
    reason: kind === 'oversell' ? 'oversell' : 'insufficient-cash',
  })
})

test('real account identity and unapproved intent cannot mutate the simulated account', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      const account = yield* Effect.result(broker.mutation.submit(intent({ accountId: 'real-account' })))
      const planned = yield* Effect.result(broker.mutation.submit(intent({ state: IntentState.Planned })))
      return { account, planned, state: yield* broker.snapshot }
    }),
  )
  expect(Result.isFailure(result.account)).toBe(true)
  expect(Result.isFailure(result.planned)).toBe(true)
  expect(result.state.orders).toEqual([])
})

test('delayed session close rejects quotes first available after the closing boundary', async () => {
  const closingMs = Date.parse('2026-09-04T20:00:00.000Z')
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        quoteAt: (_symbol, time) => {
          const at = time >= closingMs ? closingMs + 1 : time
          return Effect.succeed(observedQuote({ ...quote, eventAt: new Date(at).toISOString() }, at))
        },
      })
      yield* submit(broker, intent())
      yield* TestClock.setTime(closingMs + 350)
      const result = yield* broker.valuationAt('2026-09-04T20:00:00.000Z').pipe(Effect.result)
      expect(result).toMatchObject({
        _tag: 'Failure',
        failure: { message: 'Session close has no retained valuation quote' },
      })
      expect((yield* broker.snapshot).sessionCloses).toEqual([])
    }),
  )
})

test.each([0, 350])(
  'session close retains its exact valuation when processing finishes %sms later',
  async (elapsedMs) => {
    const closingMs = Date.parse('2026-09-04T20:00:00.000Z')
    const nextOpenMs = Date.parse('2026-09-08T13:30:00.000Z')
    const result = await run(
      Effect.gen(function* () {
        const broker = yield* setup({
          calendar: [
            ...config.calendar,
            { session_open: '0930', session_close: '1600', date: '2026-09-08', open: '09:30', close: '16:00' },
          ],
          quoteAt: (_symbol, time) => {
            const price = time > closingMs ? 102 : time === closingMs ? 101 : 100
            return Effect.succeed(
              observedQuote(
                {
                  ...quote,
                  eventAt: new Date(time).toISOString(),
                  marketSession:
                    time >= closingMs && time < Date.parse('2026-09-05T00:00:00.000Z') ? 'post' : 'regular',
                  bidPrice: price,
                  askPrice: price,
                },
                time,
              ),
            )
          },
        })
        yield* submit(broker, intent())
        const earlyClose = yield* Effect.result(broker.valuationAt('2026-09-04T20:00:00.000Z'))
        yield* TestClock.setTime(closingMs + elapsedMs)
        const close = yield* broker.valuationAt('2026-09-04T20:00:00.000Z')
        const repeatedClose = yield* broker.valuationAt('2026-09-04T20:00:00.000Z')
        yield* TestClock.setTime(nextOpenMs)
        return {
          earlyClose,
          close,
          repeatedClose,
          account: (yield* broker.read.account).value,
          positions: (yield* broker.read.positions).value,
        }
      }),
    )
    expect(Result.isFailure(result.earlyClose)).toBe(true)
    expect(result.close).toEqual(result.repeatedClose)
    expect(result.account.lastEquityMicros).toBe(result.close.equityMicros)
    expect(BigInt(result.account.equityMicros) - BigInt(result.account.lastEquityMicros)).toBe(5_000_000n)
    expect(result.positions[0]?.quantityAtoms).toBe('5000000000')
  },
)

test('delayed close selects the retained projection quote available at close', async () => {
  const closingMs = Date.parse('2026-09-04T20:00:00.000Z')
  const universe = {
    universeId: equityMarketProfile.universeId,
    universeSymbolHash: equityMarketProfile.universeSymbolHash,
    symbols: equityMarketProfile.universe,
    topics: { ...equityMarketProfile.sourceTopics, features: 'torghut.market-features.v1' },
  }
  await run(
    Effect.gen(function* () {
      let projection = incorporateRecordedMarketValue(
        emptyStreamingProjection('closing-quote'),
        quote,
        universe,
        startMs,
      )
      const broker = yield* setup({
        quoteAt: (symbol, atMs, source) => Effect.sync(() => observedQuoteAt(projection, symbol, atMs, source)),
      })
      yield* submit(broker, intent())
      for (const [index, availableAtMs, eventAtMs, price] of [
        [1, closingMs - 1000, closingMs - 1000, 101],
        [2, closingMs + 100, closingMs - 500, 102],
      ] as const) {
        projection = incorporateRecordedMarketValue(
          projection,
          {
            ...quote,
            sourceOffset: String(BigInt(quote.sourceOffset) + BigInt(index)),
            eventAt: new Date(eventAtMs).toISOString(),
            ingestedAt: new Date(availableAtMs).toISOString(),
            bidPrice: price,
            askPrice: price,
          },
          universe,
          availableAtMs,
        )
      }
      expect(projection.quotes.get('AAPL')?.value.bidPrice).toBe(102)
      expect(projection.quoteHistory.get('AAPL')).toHaveLength(3)
      yield* TestClock.setTime(closingMs + 350)
      const close = yield* broker.valuationAt('2026-09-04T20:00:00.000Z')
      const state = yield* broker.snapshot
      expect(close.equityMicros).toBe((BigInt(state.ledger.cashMicros) + 505_000_000n).toString())
      expect(state.ledger.positions[0]?.quantityAtoms).toBe('5000000000')
      expect(state.fills).toHaveLength(1)
    }),
  )
})

test('restart retains account inception when reconstructing an unreported regular close', async () => {
  await run(
    Effect.gen(function* () {
      const settings: ReplayBrokerConfig = {
        ...config,
        calendar: [
          ...config.calendar,
          { session_open: '0930', session_close: '1600', date: '2026-09-08', open: '09:30', close: '16:00' },
        ],
      }
      const broker = yield* setup(settings)
      yield* TestClock.setTime(Date.parse('2026-09-04T20:00:00.350Z'))
      const checkpoint = yield* broker.checkpoint
      expect(checkpoint.state.sessionCloses).toEqual([])
      const { checkpointHash: _hash, ...material } = checkpoint
      const future = { ...material, state: { ...material.state, createdAt: '2026-09-04T20:00:00.351Z' } }
      expect(
        Result.isFailure(
          restoreReplayBrokerCheckpoint(
            { ...future, checkpointHash: Result.getOrThrow(canonicalHashV1Result(future)) },
            settings,
          ),
        ),
      ).toBe(true)
      const { createdAt: _createdAt, ...retiredState } = material.state
      const retired = {
        ...material,
        schemaVersion: 'bayn.simulated-broker-checkpoint.v4',
        state: { ...retiredState, schemaVersion: 'bayn.simulated-broker-state.v2' },
      }
      expect(
        Result.isFailure(
          restoreReplayBrokerCheckpoint(
            { ...retired, checkpointHash: Result.getOrThrow(canonicalHashV1Result(retired)) },
            settings,
          ),
        ),
      ).toBe(true)
      const recovered = yield* makeReplayBroker({
        ...settings,
        restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
      })
      yield* TestClock.setTime(Date.parse('2026-09-08T13:30:00.000Z'))
      expect((yield* recovered.read.account).value.lastEquityMicros).toBe(config.openingCashMicros)
    }),
  )
})

test('missing retained close pricing prevents a fabricated next-day equity baseline', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        quoteAt: (_symbol, at) =>
          Effect.succeed(
            at === Date.parse('2026-09-04T20:00:00.000Z')
              ? undefined
              : observedQuote(
                  { ...quote, eventAt: new Date(at).toISOString(), ingestedAt: new Date(at).toISOString() },
                  at,
                ),
          ),
        calendar: [
          ...config.calendar,
          { session_open: '0930', session_close: '1600', date: '2026-09-08', open: '09:30', close: '16:00' },
        ],
      })
      yield* submit(broker, intent())
      yield* TestClock.setTime(Date.parse('2026-09-08T13:30:00.000Z'))
      return yield* Effect.result(broker.read.account)
    }),
  )
  expect(Result.isFailure(result)).toBe(true)
})

test.each([
  { kind: 'stale', expected: false },
  { kind: 'zero-bid', expected: false },
  { kind: 'fresh', expected: true },
] as const)('session close reports whether its held-position mark qualifies: %s', async ({ kind, expected }) => {
  const closeMs = Date.parse('2026-09-04T20:00:00.000Z')
  const closing = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        quoteAt: (_symbol, atMs) =>
          Effect.succeed(
            atMs === closeMs && kind !== 'stale'
              ? observedQuote(
                  {
                    ...quote,
                    eventAt: new Date(closeMs).toISOString(),
                    marketSession: 'post',
                    ingestedAt: new Date(closeMs).toISOString(),
                    bidSize: kind === 'zero-bid' ? 0 : quote.bidSize,
                    sourceOffset: '2',
                  },
                  closeMs,
                )
              : observedQuote(quote),
          ),
      })
      yield* submit(broker, intent())
      yield* TestClock.setTime(closeMs)
      return yield* broker.valuationAt('2026-09-04T20:00:00.000Z')
    }),
  )
  expect(closing.valuationQualified).toBe(expected)
})

test('position evidence retains the valuation timestamp across asynchronous quote lookup', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ quoteAt: () => TestClock.adjust(1).pipe(Effect.as(observedQuote(quote))) })
      yield* submit(broker, intent())
      return yield* broker.read.positions
    }),
  )
  expect(Result.isSuccess(positionSnapshot(`replay-${runId}`, result))).toBe(true)
})

test('a quote gap retains an evidenced position mark but cannot supply an executable quote', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      yield* submit(broker, intent())
      yield* TestClock.adjust(protocol.maximumQuoteAgeMs + 1)
      const account = (yield* broker.read.account).value
      const valuation = yield* broker.valuation
      yield* submit(broker, intent({ intentId: '7'.repeat(64), clientOrderId: 'stale-second-buy' }))
      return { account, valuation, state: yield* broker.snapshot }
    }),
  )
  expect(result.valuation).toMatchObject({
    model: 'last-observed-bid',
    marks: [{ symbol: 'AAPL', priceMicros: '100000000', eventAt: observedAt, staleForExecution: true }],
  })
  expect(BigInt(result.valuation.marks[0]?.ageNanos ?? '0')).toBeGreaterThan(
    BigInt(protocol.maximumQuoteAgeMs) * 1_000_000n,
  )
  expect(result.account.equityMicros).toBe((BigInt(result.state.ledger.cashMicros) + 500_000_000n).toString())
  expect(result.state.fills).toHaveLength(1)
  expect(result.state.orders[1]?.executions.at(-1)?.outcome).toMatchObject({
    status: 'unfilled',
    reason: ReplayQuoteRejection.Stale,
  })
})

test('a zero-size bid remains an accounting mark but cannot qualify held-position economics', async () => {
  let afterFill = false
  const valuation = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        quoteAt: () => Effect.succeed(observedQuote(afterFill ? { ...quote, bidSize: 0 } : quote)),
      })
      yield* submit(broker, intent())
      afterFill = true
      return yield* broker.valuation
    }),
  )
  expect(valuation.marks).toMatchObject([{ symbol: 'AAPL', bidLiquidityAvailable: false }])
})

test.each(['missing', 'future', 'crossed', 'other-feed'] as const)(
  'valuation rejects %s quotes after an actual fill',
  async (kind) => {
    let afterFill = false
    const result = await run(
      Effect.gen(function* () {
        const broker = yield* setup({
          quoteAt: () =>
            Effect.succeed(
              !afterFill
                ? observedQuote(quote)
                : kind === 'missing'
                  ? undefined
                  : observedQuote({
                      ...quote,
                      eventAt: kind === 'future' ? new Date(startMs + 60_000).toISOString() : quote.eventAt,
                      askPrice: kind === 'crossed' ? 99 : quote.askPrice,
                      feed: kind === 'other-feed' ? 'sip' : quote.feed,
                    }),
            ),
        })
        yield* submit(broker, intent())
        afterFill = true
        return yield* Effect.result(broker.read.account)
      }),
    )
    expect(Result.isFailure(result)).toBeTrue()
  },
)

test.each(['failure', 'defect', 'conversion'] as const)(
  'delivery %s leaves a terminal recoverable IOC',
  async (kind) => {
    const result = await run(
      Effect.gen(function* () {
        const broker = yield* setup({
          quoteAt: () =>
            kind === 'failure'
              ? Effect.fail(new ReplayBrokerFailure({ message: 'Quote source unavailable' }))
              : kind === 'defect'
                ? Effect.die(new Error('Quote callback defect'))
                : Effect.succeed(observedQuote({ ...quote, askSize: Number.POSITIVE_INFINITY })),
        })
        const failed = yield* Effect.exit(submit(broker, intent()))
        const recovered = yield* broker.read.orderByClientId(intent().clientOrderId)
        const repeated = yield* broker.mutation.submit(intent())
        return { failed, recovered, repeated, state: yield* broker.snapshot }
      }),
    )
    expect(Exit.isFailure(result.failed)).toBe(true)
    expect(result.recovered.value.status).toBe(OrderStatus.Canceled)
    expect(result.repeated.order.status).toBe(OrderStatus.Canceled)
    expect(result.state.orders[0]?.deliveryFailure).toBeDefined()
    expect(result.state.ledger.fills).toEqual([])
  },
)

test.each([0, 60_000])(
  'DAY arriving at or beyond close expires at close with latency %d and preserves closing equity',
  async (latencyMs) => {
    const close = Date.parse('2026-09-04T20:00:00Z')
    const arrivals: number[] = []
    const result = await run(
      Effect.gen(function* () {
        const broker = yield* setup({
          assumptions: { ...config.assumptions, latencyMs },
          advanceToArrival: (atMs) =>
            Effect.sync(() => {
              arrivals.push(atMs)
            }).pipe(Effect.andThen(TestClock.setTime(atMs))),
          quoteAt: () => Effect.die(new Error('An expired DAY must not read an execution quote')),
        })
        yield* TestClock.setTime(latencyMs === 0 ? close : close - 30_000)
        const receipt = yield* broker.mutation.submit(intent())
        const closing = yield* broker.valuationAt('2026-09-04T20:00:00.000Z')
        const duplicate = yield* broker.mutation.submit(intent())
        return { receipt, duplicate, closing, atMs: yield* Clock.currentTimeMillis, state: yield* broker.snapshot }
      }),
    )
    expect(arrivals).toEqual([close])
    expect(result.atMs).toBe(close)
    expect(result.receipt.order.status).toBe(OrderStatus.Expired)
    expect(result.receipt.order.updatedAt).toBe('2026-09-04T20:00:00.000Z')
    expect(result.duplicate.order.brokerOrderId).toBe(result.receipt.order.brokerOrderId)
    expect(result.state.fills).toEqual([])
    expect(result.state.ledger.cashMicros).toBe(config.openingCashMicros)
    expect(result.closing.equityMicros).toBe(config.openingCashMicros)
  },
)
test('checkpoint restores exact fills, activities, request identity and idempotent order recovery', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      const original = yield* submit(broker, intent())
      const checkpoint = yield* broker.checkpoint
      const restored = yield* makeReplayBroker({
        ...config,
        restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
      })
      expect(yield* restored.snapshot).toEqual(yield* broker.snapshot)
      expect((yield* restored.read.orderByClientId(intent().clientOrderId)).value).toEqual(original.order)
      yield* restored.mutation.submit(intent())
      expect((yield* restored.snapshot).fills).toHaveLength(1)
      expect((yield* restored.read.account).value.cashMicros).toBe((yield* broker.read.account).value.cashMicros)
      expect(yield* restored.checkpoint).toEqual(checkpoint)
    }),
  )
})

test('checkpoint rejects changed economics, requests, source, configuration and restore time', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      yield* submit(broker, intent())
      const checkpoint = yield* broker.checkpoint
      const changedCash = {
        ...checkpoint,
        state: { ...checkpoint.state, ledger: { ...checkpoint.state.ledger, cashMicros: '1' } },
      }
      const changedRequest = {
        ...checkpoint,
        state: {
          ...checkpoint.state,
          orders: checkpoint.state.orders.map((order) => ({ ...order, requestHash: '0'.repeat(64) })),
        },
      }
      for (const changed of [changedCash, changedRequest]) {
        const { checkpointHash: _checkpointHash, ...material } = changed
        const resigned = { ...material, checkpointHash: Result.getOrThrow(canonicalHashV1Result(material)) }
        expect(
          (yield* Effect.exit(
            makeReplayBroker({
              ...config,
              restoreCheckpoint: { value: resigned, expectedHash: resigned.checkpointHash },
            }),
          ))._tag,
        ).toBe('Failure')
      }
      expect(
        (yield* Effect.exit(
          makeReplayBroker({
            ...config,
            sourceManifestHash: 'd'.repeat(64),
            restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
          }),
        ))._tag,
      ).toBe('Failure')
      expect(
        (yield* Effect.exit(
          makeReplayBroker({
            ...config,
            assumptions: { ...config.assumptions, latencyMs: 200 },
            restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
          }),
        ))._tag,
      ).toBe('Failure')
      yield* TestClock.adjust(1)
      expect(
        (yield* Effect.exit(
          makeReplayBroker({
            ...config,
            restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
          }),
        ))._tag,
      ).toBe('Failure')
    }),
  )
})

test('checkpoint cannot claim pending delivery survived a process restart', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      const pending = yield* broker.mutation.submit(intent()).pipe(Effect.forkChild({ startImmediately: true }))
      expect((yield* Effect.exit(broker.checkpoint))._tag).toBe('Failure')
      yield* TestClock.adjust(100)
      yield* Fiber.join(pending)
      expect((yield* broker.checkpoint).state.fills).toHaveLength(1)
    }),
  )
})

test('checkpoint restoration verifies fill prices against the retained arrival quote', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      yield* submit(broker, intent())
      const checkpoint = yield* broker.checkpoint
      const material = {
        schemaVersion: checkpoint.schemaVersion,
        configurationHash: checkpoint.configurationHash,
        sourceManifestHash: checkpoint.sourceManifestHash,
        observedAt: checkpoint.observedAt,
        state: {
          ...checkpoint.state,
          ledger: {
            ...checkpoint.state.ledger,
            cashMicros: '9504990000',
            positions: checkpoint.state.ledger.positions.map((position) => ({
              ...position,
              costBasisMicros: '495000000',
            })),
            fills: checkpoint.state.ledger.fills.map((fill) => ({
              ...fill,
              priceMicros: '99000000',
              notionalMicros: '495000000',
            })),
          },
          fills: checkpoint.state.fills.map((fill) => ({ ...fill, priceMicros: '99000000' })),
          orders: checkpoint.state.orders.map((entry) => ({
            ...entry,
            order: { ...entry.order, filledAveragePriceMicros: '99000000' },
          })),
        },
      }
      const forged = { ...material, checkpointHash: Result.getOrThrow(canonicalHashV1Result(material)) }
      const outcome = yield* Effect.exit(
        makeReplayBroker({ ...config, restoreCheckpoint: { value: forged, expectedHash: forged.checkpointHash } }),
      )
      expect(outcome._tag).toBe('Failure')
    }),
  )
})

test('checkpoint restoration recomputes closing equity instead of trusting a rehashed mark', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      yield* TestClock.setTime(Date.parse('2026-09-04T20:00:00Z'))
      yield* broker.valuationAt('2026-09-04T20:00:00.000Z')
      const checkpoint = yield* broker.checkpoint
      const { checkpointHash: _hash, ...material } = checkpoint
      const altered = {
        ...material,
        state: {
          ...material.state,
          sessionCloses: [{ sessionDate: '2026-09-04', equityMicros: '1', valuationQualified: true }],
        },
      }
      const forged = { ...altered, checkpointHash: Result.getOrThrow(canonicalHashV1Result(altered)) }
      expect(
        (yield* Effect.exit(
          makeReplayBroker({ ...config, restoreCheckpoint: { value: forged, expectedHash: forged.checkpointHash } }),
        ))._tag,
      ).toBe('Failure')
    }),
  )
})

test('an independently retained checkpoint hash rejects a forged zero-fill cancellation', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      yield* submit(broker, intent())
      const checkpoint = yield* broker.checkpoint
      const { checkpointHash: _hash, ...material } = checkpoint
      const altered = {
        ...material,
        state: {
          ...material.state,
          ledger: {
            ...material.state.ledger,
            cashMicros: config.openingCashMicros,
            executionFeesMicros: '0',
            netRealizedPnlAfterCostsMicros: '0',
            positions: [],
            fills: [],
          },
          fills: [],
          fees: [],
          orders: material.state.orders.map((entry) => {
            const { filledAt: _filledAt, filledAveragePriceMicros: _price, ...order } = entry.order
            return {
              ...entry,
              executions: [],
              order: {
                ...order,
                canceledAt: checkpoint.observedAt,
                filledQuantityAtoms: '0',
                status: OrderStatus.Canceled,
              },
            }
          }),
        },
      }
      const forged = { ...altered, checkpointHash: Result.getOrThrow(canonicalHashV1Result(altered)) }
      expect(Result.isSuccess(restoreReplayBrokerCheckpoint(forged, config))).toBe(true)
      expect(
        (yield* Effect.exit(
          makeReplayBroker({
            ...config,
            restoreCheckpoint: { value: forged, expectedHash: checkpoint.checkpointHash },
          }),
        ))._tag,
      ).toBe('Failure')
    }),
  )
})

test('settlement persistence completes before a calculated fill becomes observable', async () => {
  await run(
    Effect.gen(function* () {
      const calculated = yield* Deferred.make<void>()
      const committed = yield* Deferred.make<void>()
      const broker = yield* setup({
        retainSettlement: (checkpoint) =>
          Effect.gen(function* () {
            expect(checkpoint.state.fills).toHaveLength(1)
            yield* Deferred.succeed(calculated, undefined)
            yield* Deferred.await(committed)
          }),
      })
      const pending = yield* broker.mutation.submit(intent()).pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust(100)
      yield* Deferred.await(calculated)
      expect((yield* broker.snapshot).fills).toHaveLength(0)
      expect((yield* broker.read.account).value.cashMicros).toBe(config.openingCashMicros)
      yield* Deferred.succeed(committed, undefined)
      const response = yield* Fiber.join(pending)
      expect(response.order.status).toBe(OrderStatus.Filled)
      expect((yield* broker.snapshot).fills).toHaveLength(1)
    }),
  )
})

test('an uncertain settlement commit blocks further broker state reads and mutations until restoration', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        retainSettlement: () => Effect.fail(new ReplayBrokerFailure({ message: 'commit acknowledgment lost' })),
      })
      expect((yield* Effect.exit(submit(broker, intent())))._tag).toBe('Failure')
      for (const exit of [
        yield* Effect.exit(broker.snapshot),
        yield* Effect.exit(broker.read.account),
        yield* Effect.exit(broker.read.orderByClientId(intent().clientOrderId)),
        yield* Effect.exit(broker.mutation.submit(intent())),
      ]) {
        expect(exit._tag).toBe('Failure')
        expect(JSON.stringify(exit)).toContain('restore durable state')
      }
    }),
  )
})

test('cancellation commits before its response and can restore before delivery latency elapses', async () => {
  await run(
    Effect.gen(function* () {
      const calculated = yield* Deferred.make<ReplayBrokerCheckpoint>()
      const committed = yield* Deferred.make<void>()
      const broker = yield* setup({
        retainSettlement: (checkpoint) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(calculated, checkpoint)
            yield* Deferred.await(committed)
          }),
      })
      const submitFiber = yield* broker.mutation.submit(intent()).pipe(Effect.forkChild({ startImmediately: true }))
      const pending = (yield* broker.read.orders({ status: OrderCollection.Open })).value[0]
      if (pending === undefined) throw new Error('expected pending IOC')
      const cancelFiber = yield* broker.mutation
        .cancel(pending.brokerOrderId)
        .pipe(Effect.forkChild({ startImmediately: true }))
      const checkpoint = yield* Deferred.await(calculated)
      expect(checkpoint.state.orders[0]?.order.status).toBe(OrderStatus.Canceled)
      expect((yield* broker.read.orderById(pending.brokerOrderId)).value.status).toBe(OrderStatus.New)
      yield* Deferred.succeed(committed, undefined)
      yield* Fiber.join(cancelFiber)
      const restored = yield* makeReplayBroker({
        ...config,
        restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
      })
      expect((yield* restored.read.orderById(pending.brokerOrderId)).value.status).toBe(OrderStatus.Canceled)
      expect((yield* restored.snapshot).fills).toHaveLength(0)
      yield* TestClock.adjust(100)
      expect((yield* Fiber.join(submitFiber)).order.status).toBe(OrderStatus.Canceled)
    }),
  )
})

test('delivery failures retain terminal evidence and prevent session acceptance', async () => {
  await run(
    Effect.gen(function* () {
      const retained: ReplayBrokerCheckpoint[] = []
      const broker = yield* setup({
        retainSettlement: (checkpoint) =>
          Effect.sync(() => {
            retained.push(checkpoint)
          }),
        quoteAt: () => Effect.fail(new ReplayBrokerFailure({ message: 'arrival source failed' })),
      })
      expect((yield* Effect.exit(submit(broker, intent())))._tag).toBe('Failure')
      expect(retained.at(-1)?.state.orders[0]?.order.status).toBe(OrderStatus.Canceled)
      expect(retained.at(-1)?.state.orders[0]?.deliveryFailure).toBeDefined()
      yield* TestClock.setTime(Date.parse('2026-09-04T20:00:00Z'))
      expect((yield* Effect.exit(broker.valuationAt('2026-09-04T20:00:00.000Z')))._tag).toBe('Failure')
      expect((yield* broker.snapshot).sessionCloses).toEqual([])
    }),
  )
})

test('bounded LIMIT/DAY close liquidates at the adverse arrival price and survives restore', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        advanceToArrival: (at) => TestClock.setTime(at),
        assumptions: { ...config.assumptions, slippageBps: 1 },
      })
      yield* broker.mutation.submit(intent())
      const close = intent({
        clientOrderId: 'bounded-close',
        side: OrderSide.Sell,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        limitPriceMicros: '99990000',
        notionalLimitMicros: '499950000',
      })
      const result = yield* broker.mutation.submit(close)
      expect(result.order.orderType).toBe(BrokerOrderType.Limit)
      expect(result.order.timeInForce).toBe(BrokerTimeInForce.Day)
      expect(result.order.limitPriceMicros).toBe('99990000')
      expect(result.order.status).toBe(OrderStatus.Filled)
      expect(result.order.filledAveragePriceMicros).toBe('99990000')
      expect((yield* broker.snapshot).ledger.positions).toEqual([])
      const checkpoint = yield* broker.checkpoint
      const restored = yield* makeReplayBroker({
        ...config,
        assumptions: { ...config.assumptions, slippageBps: 1 },
        restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
      })
      expect((yield* restored.snapshot).ledger.positions).toEqual([])
    }),
  )
})

test('fractional LIMIT closes preserve residual inventory, fees, and restart evidence', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({ fractionalTrading: true, advanceToArrival: (at) => TestClock.setTime(at) })
      yield* broker.mutation.submit(intent())
      for (const [index, quantityAtoms] of ['500000000', '4500000000'].entries()) {
        const closed = yield* broker.mutation.submit(
          intent({
            clientOrderId: `fractional-close-${index}`,
            side: OrderSide.Sell,
            orderType: OrderType.Limit,
            timeInForce: TimeInForce.Day,
            quantityAtoms,
            limitPriceMicros: '100000000',
            notionalLimitMicros: ((BigInt(quantityAtoms) * 100000000n) / 1000000000n).toString(),
          }),
        )
        expect(closed.order.filledQuantityAtoms).toBe(quantityAtoms)
        const checkpoint = yield* broker.checkpoint
        const restored = yield* makeReplayBroker({
          ...config,
          fractionalTrading: true,
          restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
        })
        expect(yield* restored.snapshot).toEqual(yield* broker.snapshot)
      }
      const state = yield* broker.snapshot
      expect(state.ledger.positions).toEqual([])
      expect(BigInt(state.ledger.cashMicros) + BigInt(state.ledger.executionFeesMicros)).toBe(
        BigInt(config.openingCashMicros),
      )
    }),
  )
})

for (const scenario of ['missing', 'stale', 'future', 'thin', 'zero'] as const) {
  test(`LIMIT close with ${scenario} arrival evidence retains the actual partial or resting state`, async () => {
    await run(
      Effect.gen(function* () {
        let closing = false
        const broker = yield* setup({
          advanceToArrival: (at) => TestClock.setTime(at),
          quoteAt: (_symbol, at) =>
            Effect.succeed(
              !closing
                ? observedQuote(quote)
                : scenario === 'missing'
                  ? undefined
                  : observedQuote(
                      {
                        ...quote,
                        eventAt: new Date(
                          scenario === 'stale'
                            ? at - protocol.maximumQuoteAgeMs - 1
                            : scenario === 'future'
                              ? at + 1
                              : at,
                        ).toISOString(),
                        bidSize: scenario === 'thin' ? 2 : scenario === 'zero' ? 0 : quote.bidSize,
                      },
                      at,
                    ),
            ),
        })
        yield* broker.mutation.submit(intent())
        closing = true
        const receipt = yield* broker.mutation.submit(
          intent({
            clientOrderId: 'bounded-pending-close',
            side: OrderSide.Sell,
            limitPriceMicros: '100000000',
            notionalLimitMicros: '500000000',
          }),
        )
        const state = yield* broker.snapshot
        expect(receipt.order.status).toBe(scenario === 'thin' ? OrderStatus.PartiallyFilled : OrderStatus.New)
        expect(state.fills).toHaveLength(scenario === 'thin' ? 2 : 1)
        expect(state.ledger.positions[0]?.quantityAtoms).toBe(scenario === 'thin' ? '3000000000' : '5000000000')
        expect(state.orders[1]?.deliveryFailure).toBeUndefined()
        const checkpoint = yield* broker.checkpoint
        expect(Result.isSuccess(restoreReplayBrokerCheckpoint(checkpoint, { ...config }))).toBe(true)
      }),
    )
  })
}

test('fractional LIMIT close requires the captured account fractional-trading setting', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({ fractionalTrading: false, advanceToArrival: (at) => TestClock.setTime(at) })
      yield* broker.mutation.submit(intent())
      const close = intent({
        clientOrderId: 'disabled-fractional-close',
        side: OrderSide.Sell,
        orderType: OrderType.Limit,
        timeInForce: TimeInForce.Day,
        quantityAtoms: '500000000',
        limitPriceMicros: '100000000',
        notionalLimitMicros: '50000000',
      })
      expect((yield* Effect.exit(broker.mutation.submit(close)))._tag).toBe('Failure')
      expect((yield* broker.snapshot).orders).toHaveLength(1)
    }),
  )
})

const cryptoAsset = (symbol: string, observedAt: string) =>
  Result.getOrThrow(
    normalizeAssetResult(
      {
        id: '12345678-1234-4234-8234-123456789abc',
        symbol,
        class: AssetClass.Crypto,
        exchange: AssetExchange.Crypto,
        status: AssetStatus.Active,
        tradable: true,
        fractionable: true,
        min_order_size: '0.00001',
        min_trade_increment: '0.000000001',
        price_increment: '0.000000001',
      },
      symbol,
      observedAt,
    ),
  )

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
  test(`${symbol} IOC cancels its partial remainder and cannot fill on a later quote`, async () => {
    const cryptoQuote = observedQuote({
      ...quote,
      symbol,
      feed: 'us',
      delayClass: 'real_time_crypto',
      marketSession: 'continuous',
      askSize: 2,
      sourceTopic: 'torghut.crypto.quotes.v1',
    })
    const state = await run(
      Effect.gen(function* () {
        const broker = yield* setup({
          assets: [cryptoAsset(symbol, observedAt)],
          fractionalTrading: true,
          quoteAt: () => Effect.succeed(cryptoQuote),
        })
        const first = yield* submit(broker, intent({ symbol, timeInForce: TimeInForce.ImmediateOrCancel }))
        expect(first.order.status).toBe(OrderStatus.Canceled)
        expect(first.order.filledQuantityAtoms).toBe('2000000000')
        const at = startMs + 1_000
        yield* broker.observeMarket(
          at,
          observedQuote(
            {
              ...cryptoQuote.value,
              eventAt: new Date(at).toISOString(),
              ingestedAt: new Date(at).toISOString(),
              askSize: 100,
              sourceOffset: '2',
            },
            at,
          ),
        )
        yield* TestClock.setTime(at)
        return yield* broker.snapshot
      }),
    )
    expect(state.orders[0]?.order.status).toBe(OrderStatus.Canceled)
    expect(state.ledger.fills).toHaveLength(1)
    expect(state.ledger.fills[0]?.quantityAtoms).toBe('2000000000')
  })
  test(`${symbol} settles and restores the shared broker across Sunday midnight with coin fees and an IOC close`, async () => {
    const start = Date.parse('2026-10-11T23:59:59.850Z')
    const asset = cryptoAsset(symbol, new Date(start).toISOString())
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(start)
        const frozen: ReplayBrokerConfig = {
          ...config,
          calendar: [],
          assets: [asset],
          fractionalTrading: true,
          quoteAt: (_symbol, atMs) =>
            Effect.succeed(
              observedQuote(
                {
                  ...quote,
                  symbol,
                  feed: 'us',
                  delayClass: 'real_time_crypto',
                  marketSession: 'continuous',
                  eventAt: new Date(atMs).toISOString(),
                  ingestedAt: new Date(atMs).toISOString(),
                },
                atMs,
              ),
            ),
        }
        const broker = yield* makeReplayBroker(frozen)
        const openingAccount = (yield* broker.read.account).value
        expect(openingAccount.cryptoStatus).toBe('ACTIVE')
        expect(openingAccount.nonMarginableBuyingPowerMicros).toBe(config.openingCashMicros)
        yield* submit(
          broker,
          intent({
            limitPriceMicros: ((BigInt('3338050') * 1000000000n) / BigInt('33050000')).toString(),

            symbol,
            timeInForce: TimeInForce.ImmediateOrCancel,
            quantityAtoms: '33050000',
            notionalLimitMicros: '3338050',
            createdAt: new Date(start).toISOString(),
          }),
        )
        const held = yield* broker.checkpoint
        expect(held.state.ledger.positions[0]?.quantityAtoms).toBe('32967375')
        expect(held.state.orders[0]?.order.assetClass).toBe(AssetClass.Crypto)
        expect(held.state.fees[0]?.netAmountMicros).toBe('0')
        expect(held.state.fees[0]?.coinDebit?.quantityAtoms).toBe('82625')
        expect((yield* broker.read.account).value.nonMarginableBuyingPowerMicros).toBe(held.state.ledger.cashMicros)
        expect(Result.getOrThrow(restoreReplayBrokerCheckpoint(held, frozen)).state.ledger).toEqual(held.state.ledger)
        const restored = yield* makeReplayBroker({
          ...frozen,
          restoreCheckpoint: { value: held, expectedHash: held.checkpointHash },
        })
        const midnight = Date.parse('2026-10-12T00:00:00.000Z')
        yield* TestClock.setTime(midnight)
        const mark = yield* restored.valuationAt(new Date(midnight).toISOString())
        expect(mark.at).toBe('2026-10-12T00:00:00.000Z')
        expect(mark.valuationQualified).toBe(true)
        expect(yield* restored.snapshot).toEqual(held.state)
        const close = intent({
          limitPriceMicros: '100000000',

          symbol,
          side: OrderSide.Sell,
          orderType: OrderType.Limit,
          timeInForce: TimeInForce.ImmediateOrCancel,
          quantityAtoms: '32967375',
          notionalLimitMicros: '3296737',
          clientOrderId: 'replay-sell-1',
          createdAt: new Date(start + 100).toISOString(),
        })
        const pending = yield* restored.mutation.submit(close).pipe(Effect.forkChild({ startImmediately: true }))
        yield* TestClock.adjust(100)
        yield* Fiber.join(pending)
        yield* restored.mutation.submit(close)
        const flat = yield* restored.checkpoint
        expect(flat.state.orders).toHaveLength(2)
        expect(flat.state.ledger.positions).toEqual([])
        expect(flat.state.ledger.fills).toHaveLength(2)
        expect(flat.state.orders[1]?.order.timeInForce).toBe(BrokerTimeInForce.ImmediateOrCancel)
        expect(Result.getOrThrow(restoreReplayBrokerCheckpoint(flat, frozen)).state.ledger).toEqual(flat.state.ledger)
        expect(flat.state.fees[1]?.cryptoCashFee).toBe(true)
        expect((yield* restored.read.account).value.nonMarginableBuyingPowerMicros).toBe(flat.state.ledger.cashMicros)
        expect(Result.getOrThrow(restoreReplayBrokerCheckpoint(flat, frozen)).state.fees).toEqual(flat.state.fees)
        const { checkpointHash: _hash, ...material } = flat
        const oldMaterial = {
          ...material,
          schemaVersion: 'bayn.simulated-broker-checkpoint.v2',
          state: {
            ...material.state,
            fees: material.state.fees.map(({ cryptoCashFee: _kind, ...fee }) => fee),
          },
        }
        const oldCheckpoint = { ...oldMaterial, checkpointHash: Result.getOrThrow(canonicalHashV1Result(oldMaterial)) }
        expect(Result.isFailure(restoreReplayBrokerCheckpoint(oldCheckpoint, frozen))).toBe(true)
      }),
    )
  })
}

test('a new weekend account uses its opening capital before its first broker reference close', async () => {
  const sunday = Date.parse('2026-10-18T23:59:00.000Z')
  const calendar: ReplayBrokerConfig['calendar'] = [
    { session_open: '0930', session_close: '1600', date: '2026-10-16', open: '09:30', close: '16:00' },
    { session_open: '0930', session_close: '1600', date: '2026-10-19', open: '09:30', close: '16:00' },
  ]
  const quoteAt: ReplayBrokerConfig['quoteAt'] = () => Effect.die('A new flat account must not invent a price')
  const value = await run(
    Effect.gen(function* () {
      yield* TestClock.setTime(sunday)
      const broker = yield* makeReplayBroker({ ...config, calendar, quoteAt })
      const account = yield* broker.read.account
      yield* TestClock.setTime(sunday + 120_000)
      const checkpoint = yield* broker.checkpoint
      const restored = yield* makeReplayBroker({
        ...config,
        calendar,
        quoteAt,
        restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
      })
      return { account: account.value, restored: (yield* restored.read.account).value, state: yield* restored.snapshot }
    }),
  )
  expect(value.account.lastEquityMicros).toBe(config.openingCashMicros)
  expect(value.restored.lastEquityMicros).toBe(config.openingCashMicros)
  expect(value.state.createdAt).toBe(new Date(sunday).toISOString())
  expect(value.state.sessionCloses).toEqual([])
})

test('a resting equity DAY order survives a winter UTC report and expires at the broker close', async () => {
  const entryAt = Date.parse('2026-11-04T21:59:00.000Z')
  const midnight = Date.parse('2026-11-05T00:00:00.000Z')
  const closingAt = Date.parse('2026-11-05T01:00:00.000Z')
  await run(
    Effect.gen(function* () {
      yield* TestClock.setTime(entryAt)
      const broker = yield* makeReplayBroker({
        ...config,
        calendar: [{ session_open: '0400', session_close: '2000', date: '2026-11-04', open: '09:30', close: '16:00' }],
        quoteAt: () =>
          Effect.succeed(
            observedQuote(
              {
                ...quote,
                eventAt: new Date(entryAt).toISOString(),
                ingestedAt: new Date(entryAt).toISOString(),
                marketSession: 'post',
                bidPrice: 100,
                askPrice: 100.01,
              },
              entryAt,
            ),
          ),
      })
      const submitted = yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('500000000') * 1000000000n) / BigInt('5000000000')).toString(),
          createdAt: new Date(entryAt).toISOString(),
          notionalLimitMicros: '500000000',
        }),
      )
      expect(submitted.order.status).toBe(OrderStatus.New)
      yield* TestClock.setTime(midnight)
      const before = yield* broker.snapshot
      const mark = yield* broker.valuationAt(new Date(midnight).toISOString())
      expect(mark).toMatchObject({
        equityMicros: config.openingCashMicros,
        openOrderCount: 1,
        valuationQualified: true,
      })
      expect(yield* broker.snapshot).toEqual(before)
      yield* TestClock.setTime(closingAt)
      expect((yield* broker.read.orderById(submitted.order.brokerOrderId)).value.status).toBe(OrderStatus.Expired)
      expect((yield* broker.valuationAt(new Date(midnight).toISOString())).openOrderCount).toBe(1)
      expect((yield* broker.valuationAt(new Date(closingAt).toISOString())).openOrderCount).toBe(0)
      expect((yield* broker.snapshot).ledger.positions).toEqual([])
    }),
  )
})

test('extended-hours reports preserve the regular-close broker equity reference', async () => {
  const entryAt = Date.parse('2026-11-04T14:31:00.000Z')
  const regularClose = Date.parse('2026-11-04T21:00:00.000Z')
  const dataClose = Date.parse('2026-11-04T22:00:00.000Z')
  const points = [
    observedQuote(
      { ...quote, eventAt: new Date(entryAt).toISOString(), ingestedAt: new Date(entryAt).toISOString() },
      entryAt,
    ),
    observedQuote(
      {
        ...quote,
        eventAt: new Date(regularClose - 1).toISOString(),
        ingestedAt: new Date(regularClose - 1).toISOString(),
        sourceOffset: '1',
        bidPrice: 101,
        askPrice: 101,
      },
      regularClose - 1,
    ),
    observedQuote(
      {
        ...quote,
        eventAt: new Date(dataClose - 1).toISOString(),
        ingestedAt: new Date(dataClose - 1).toISOString(),
        sourceOffset: '2',
        marketSession: 'post',
        bidPrice: 102,
        askPrice: 102,
      },
      dataClose - 1,
    ),
  ]
  const result = await run(
    Effect.gen(function* () {
      yield* TestClock.setTime(entryAt)
      const frozen: ReplayBrokerConfig = {
        ...config,
        calendar: [{ session_open: '0400', session_close: '2000', date: '2026-11-04', open: '09:30', close: '16:00' }],
        quoteAt: (_symbol, atMs) => Effect.succeed(points.filter((q) => q.availableAtMs <= atMs).at(-1)),
      }
      let broker = yield* makeReplayBroker(frozen)
      yield* submit(
        broker,
        intent({
          limitPriceMicros: ((BigInt('500000000') * 1000000000n) / BigInt('5000000000')).toString(),
          createdAt: new Date(entryAt).toISOString(),
          notionalLimitMicros: '500000000',
        }),
      )
      yield* TestClock.setTime(regularClose)
      const regular = yield* broker.valuationAt(new Date(regularClose).toISOString())
      const checkpoint = yield* broker.checkpoint
      expect(checkpoint.state.sessionCloses).toHaveLength(1)
      broker = yield* makeReplayBroker({
        ...frozen,
        restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
      })
      yield* TestClock.setTime(dataClose)
      const extended = yield* broker.valuationAt(new Date(dataClose).toISOString())
      yield* TestClock.setTime(Date.parse('2026-11-05T14:31:00.000Z'))
      return { regular, extended, account: (yield* broker.read.account).value }
    }),
  )
  expect(result.regular.equityMicros).not.toBe(result.extended.equityMicros)
  expect(result.account.lastEquityMicros).toBe(result.regular.equityMicros)
})

test.each(['stale', 'no-bid-liquidity'])(
  'an unqualified regular-close mark survives the next day and restart: %s',
  async (mode) => {
    const entryAt = Date.parse('2026-11-04T14:31:00.000Z')
    const closeAt = Date.parse('2026-11-04T21:00:00.000Z')
    const nextDay = Date.parse('2026-11-05T14:31:00.000Z')
    const closeQuoteAt = closeAt - (mode === 'stale' ? 11_000 : 1)
    const points = [
      observedQuote(
        { ...quote, eventAt: new Date(entryAt).toISOString(), ingestedAt: new Date(entryAt).toISOString() },
        entryAt,
      ),
      observedQuote(
        {
          ...quote,
          eventAt: new Date(closeQuoteAt).toISOString(),
          ingestedAt: new Date(closeQuoteAt).toISOString(),
          sourceOffset: '1',
          bidPrice: 101,
          askPrice: 101,
          bidSize: mode === 'no-bid-liquidity' ? 0 : 100,
        },
        closeQuoteAt,
      ),
      observedQuote(
        {
          ...quote,
          eventAt: new Date(nextDay).toISOString(),
          ingestedAt: new Date(nextDay).toISOString(),
          sourceOffset: '2',
          bidPrice: 102,
          askPrice: 102,
        },
        nextDay,
      ),
    ]
    await run(
      Effect.gen(function* () {
        yield* TestClock.setTime(entryAt)
        const frozen: ReplayBrokerConfig = {
          ...config,
          calendar: [
            { session_open: '0400', session_close: '2000', date: '2026-11-04', open: '09:30', close: '16:00' },
          ],
          quoteAt: (_symbol, atMs) => Effect.succeed(points.filter((point) => point.availableAtMs <= atMs).at(-1)),
        }
        let broker = yield* makeReplayBroker(frozen)
        yield* submit(broker, intent({ createdAt: new Date(entryAt).toISOString() }))
        yield* TestClock.setTime(closeAt)
        const mark = yield* broker.valuationAt(new Date(closeAt).toISOString())
        expect(mark.valuationQualified).toBe(false)
        const checkpoint = yield* broker.checkpoint
        expect(checkpoint.state.sessionCloses).toEqual([
          { sessionDate: '2026-11-04', equityMicros: mark.equityMicros, valuationQualified: false },
        ])
        const { checkpointHash: _, ...material } = checkpoint
        const forgedMaterial = {
          ...material,
          state: {
            ...material.state,
            sessionCloses: [{ sessionDate: '2026-11-04', equityMicros: mark.equityMicros, valuationQualified: true }],
          },
        }
        const forged = { ...forgedMaterial, checkpointHash: Result.getOrThrow(canonicalHashV1Result(forgedMaterial)) }
        expect(
          (yield* Effect.exit(
            makeReplayBroker({ ...frozen, restoreCheckpoint: { value: forged, expectedHash: forged.checkpointHash } }),
          ))._tag,
        ).toBe('Failure')
        broker = yield* makeReplayBroker({
          ...frozen,
          restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
        })
        yield* TestClock.setTime(nextDay)
        expect((yield* broker.read.account).value.lastEquityMicros).toBe(mark.equityMicros)
        expect((yield* broker.valuationAt(new Date(nextDay).toISOString())).valuationQualified).toBe(false)
        expect((yield* broker.valuationAt(new Date(entryAt + 1000).toISOString())).valuationQualified).toBe(true)
        expect((yield* broker.snapshot).sessionCloses).toEqual(checkpoint.state.sessionCloses)
      }),
    )
  },
)

const bracketTerms = {
  _tag: 'Bracket',
  stopPriceMicros: '99000000',
  stopLimitPriceMicros: '98900000',
  profitLimitPriceMicros: '103000000',
} as const
const laterMarket = (delay: number, bid: number, size = 100) => {
  const at = startMs + delay
  return observedQuote(
    {
      ...quote,
      bidPrice: bid,
      askPrice: bid,
      bidSize: size,
      askSize: size,
      eventAt: new Date(at).toISOString(),
      ingestedAt: new Date(at).toISOString(),
      sourceOffset: String(delay),
    },
    at,
  )
}

test('native bracket children remain held after a partial entry and cancel with the entry', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({ quoteAt: () => Effect.succeed(observedQuote({ ...quote, askSize: 2 })) })
      const accepted = yield* submit(broker, intent({ protection: bracketTerms }))
      expect(accepted.order.status).toBe(OrderStatus.PartiallyFilled)
      expect(accepted.order.legs?.map((leg) => leg.status)).toEqual([OrderStatus.Held, OrderStatus.Held])
      yield* broker.checkpoint
      yield* broker.mutation.cancel(accepted.order.brokerOrderId)
      const checkpoint = yield* broker.checkpoint
      expect(checkpoint.state.orders.every(({ order }) => order.status === OrderStatus.Canceled)).toBe(true)
      expect(checkpoint.state.ledger.positions[0]?.quantityAtoms).toBe('2000000000')
    }),
  )
})

test('native bracket reduces the stop after a partial target and restores exact disposal accounting', async () => {
  await run(
    Effect.gen(function* () {
      const quoteAt: ReplayBrokerConfig['quoteAt'] = (_symbol, at) =>
        Effect.succeed(
          at >= startMs + 3000
            ? laterMarket(3000, 98.95)
            : at >= startMs + 2000
              ? laterMarket(2000, 98)
              : at >= startMs + 1000
                ? laterMarket(1000, 103, 2)
                : observedQuote(quote),
        )
      let broker = yield* setup({ quoteAt })
      yield* submit(broker, intent({ protection: bracketTerms }))
      yield* broker.observeMarket(startMs + 1000, laterMarket(1000, 103, 2))
      yield* TestClock.setTime(startMs + 1000)
      const partial = yield* broker.checkpoint
      expect(
        partial.state.orders.find(({ order }) => order.orderType === BrokerOrderType.StopLimit)?.order.quantityAtoms,
      ).toBe('3000000000')
      broker = yield* makeReplayBroker({
        ...config,
        quoteAt,
        restoreCheckpoint: { value: partial, expectedHash: partial.checkpointHash },
      })
      yield* broker.observeMarket(startMs + 2000, laterMarket(2000, 98))
      yield* TestClock.setTime(startMs + 2000)
      const gap = yield* broker.checkpoint
      expect(gap.state.ledger.positions[0]?.quantityAtoms).toBe('3000000000')
      expect(
        gap.state.orders.find(({ order }) => order.orderType === BrokerOrderType.StopLimit)?.order.stopTriggeredAt,
      ).toBe(new Date(startMs + 2000).toISOString())
      broker = yield* makeReplayBroker({
        ...config,
        quoteAt,
        restoreCheckpoint: { value: gap, expectedHash: gap.checkpointHash },
      })
      yield* broker.observeMarket(startMs + 3000, laterMarket(3000, 98.95))
      yield* TestClock.setTime(startMs + 3000)
      const flat = yield* broker.checkpoint
      expect(flat.state.ledger.positions).toEqual([])
      expect(flat.state.ledger.fills.map((fill) => fill.quantityAtoms)).toEqual([
        '5000000000',
        '2000000000',
        '3000000000',
      ])
      expect((yield* broker.read.orders({ status: OrderCollection.Open })).value).toEqual([])
      yield* makeReplayBroker({
        ...config,
        quoteAt,
        restoreCheckpoint: { value: flat, expectedHash: flat.checkpointHash },
      })
    }),
  )
})

test('native OCO cancellation cancels both exits before the residual can be sold', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup()
      yield* submit(broker, intent())
      const accepted = yield* submit(
        broker,
        intent({
          clientOrderId: 'native-oco',
          side: OrderSide.Sell,
          limitPriceMicros: '103000000',
          notionalLimitMicros: '515000000',
          protection: { ...bracketTerms, _tag: 'Oco', entryDecisionHash: 'a'.repeat(64) },
        }),
      )
      expect(accepted.order.legs).toHaveLength(1)
      const stop = accepted.order.legs?.[0]
      if (stop === undefined) throw new Error('Missing OCO stop')
      yield* broker.mutation.cancel(stop.brokerOrderId)
      const checkpoint = yield* broker.checkpoint
      expect((yield* broker.read.orders({ status: OrderCollection.Open })).value).toEqual([])
      expect(checkpoint.state.ledger.positions[0]?.quantityAtoms).toBe('5000000000')
    }),
  )
})

for (const symbol of ['BTC/USD', 'ETH/USD', 'SOL/USD']) {
  test(`${symbol} holds a native GTC stop across Sunday midnight and restores coin-fee net inventory`, async () => {
    await run(
      Effect.gen(function* () {
        const start = Date.parse('2026-10-11T23:59:59.700Z')
        const midnight = Date.parse('2026-10-12T00:00:00.000Z')
        yield* TestClock.setTime(start)
        const frozen: ReplayBrokerConfig = {
          ...config,
          calendar: [],
          assets: [cryptoAsset(symbol, new Date(start).toISOString())],
          fractionalTrading: true,
          quoteAt: (_symbol, at) =>
            Effect.succeed(
              observedQuote(
                {
                  ...quote,
                  symbol,
                  feed: 'us',
                  delayClass: 'real_time_crypto',
                  marketSession: 'continuous',
                  bidPrice: at >= midnight ? 99 : 100,
                  askPrice: at >= midnight ? 99 : 100,
                  eventAt: new Date(at).toISOString(),
                  ingestedAt: new Date(at).toISOString(),
                  sourceOffset: String(at),
                  sourceTopic: 'torghut.crypto.quotes.v1',
                },
                at,
              ),
            ),
        }
        let broker = yield* makeReplayBroker(frozen)
        yield* submit(broker, intent({ symbol, timeInForce: TimeInForce.ImmediateOrCancel }))
        const quantity = (yield* broker.snapshot).ledger.positions[0]?.quantityAtoms
        if (quantity === undefined) throw new Error('Missing received inventory')
        expect(BigInt(quantity)).toBeLessThan(5000000000n)
        yield* submit(
          broker,
          intent({
            symbol,
            side: OrderSide.Sell,
            clientOrderId: 'native-crypto-stop',
            orderType: OrderType.StopLimit,
            timeInForce: TimeInForce.GoodUntilCanceled,
            quantityAtoms: quantity,
            limitPriceMicros: '98900000',
            notionalLimitMicros: ((BigInt(quantity) * 98900000n) / 1000000000n).toString(),
            protection: { _tag: 'StopLimit', stopPriceMicros: '99000000', entryDecisionHash: 'a'.repeat(64) },
          }),
        )
        const checkpoint = yield* broker.checkpoint
        broker = yield* makeReplayBroker({
          ...frozen,
          restoreCheckpoint: { value: checkpoint, expectedHash: checkpoint.checkpointHash },
        })
        yield* TestClock.setTime(midnight)
        const arrival = yield* frozen.quoteAt(symbol, midnight, null)
        if (arrival === undefined) throw new Error('Missing midnight quote')
        yield* broker.observeMarket(midnight, arrival)
        const flat = yield* broker.checkpoint
        expect(flat.state.ledger.positions).toEqual([])
        expect(flat.state.orders.at(-1)?.order.timeInForce).toBe(BrokerTimeInForce.GoodUntilCanceled)
        expect(flat.state.orders.at(-1)?.order.status).toBe(OrderStatus.Filled)
        yield* makeReplayBroker({ ...frozen, restoreCheckpoint: { value: flat, expectedHash: flat.checkpointHash } })
      }),
    )
  })
}

test('routing quotes cannot fill a bracket or its children before the parent reaches the broker', async () => {
  await run(
    Effect.gen(function* () {
      let broker: Broker
      broker = yield* setup({
        assumptions: { ...config.assumptions, latencyMs: 1000 },
        quoteAt: (_symbol, at) =>
          Effect.succeed(at >= startMs + 1100 ? laterMarket(1100, 103) : laterMarket(1000, 100)),
        advanceToArrival: (at) =>
          Effect.gen(function* () {
            yield* broker.observeMarket(startMs + 500, laterMarket(500, 100))
            yield* broker.observeMarket(startMs + 700, laterMarket(700, 103))
            expect((yield* broker.snapshot).ledger.fills).toEqual([])
            yield* TestClock.setTime(at)
          }).pipe(
            Effect.mapError(
              (cause) => new ReplayBrokerFailure({ message: 'Pre-arrival quote observation failed', cause }),
            ),
          ),
      })
      yield* broker.mutation.submit(intent({ protection: bracketTerms }))
      const arrived = yield* broker.checkpoint
      expect(arrived.state.ledger.fills.map((fill) => [fill.side, fill.observedAt])).toEqual([
        ['buy', new Date(startMs + 1000).toISOString()],
      ])
      expect(
        arrived.state.orders.every(({ order }) => order.firstArrivedAt === new Date(startMs + 1000).toISOString()),
      ).toBe(true)
      yield* broker.observeMarket(startMs + 1100, laterMarket(1100, 103))
      yield* TestClock.setTime(startMs + 1100)
      const flat = yield* broker.checkpoint
      expect(flat.state.ledger.positions).toEqual([])
      expect(flat.state.ledger.fills.at(-1)?.observedAt).toBe(new Date(startMs + 1100).toISOString())
      yield* makeReplayBroker({
        ...config,
        assumptions: { ...config.assumptions, latencyMs: 1000 },
        quoteAt: (_symbol, at) =>
          Effect.succeed(at >= startMs + 1100 ? laterMarket(1100, 103) : laterMarket(1000, 100)),
        restoreCheckpoint: { value: flat, expectedHash: flat.checkpointHash },
      })
    }),
  )
})

for (const kind of ['Oco', 'StopLimit'] as const) {
  test(`${kind} cannot trigger on quotes delivered before protective-order arrival`, async () => {
    await run(
      Effect.gen(function* () {
        let broker: Broker
        let deliveries = 0
        const frozen: ReplayBrokerConfig = {
          ...config,
          assumptions: { ...config.assumptions, latencyMs: 1000 },
          quoteAt: (_symbol, at) =>
            Effect.succeed(at >= startMs + 2100 ? laterMarket(2100, 99) : laterMarket(1000, 100)),
          advanceToArrival: (at) =>
            Effect.gen(function* () {
              deliveries += 1
              if (deliveries === 2) {
                yield* broker.observeMarket(startMs + 1500, laterMarket(1500, 99))
                expect((yield* broker.snapshot).ledger.fills).toHaveLength(1)
              }
              yield* TestClock.setTime(at)
            }).pipe(
              Effect.mapError(
                (cause) => new ReplayBrokerFailure({ message: 'Pre-arrival quote observation failed', cause }),
              ),
            ),
        }
        broker = yield* setup(frozen)
        yield* broker.mutation.submit(intent())
        yield* broker.mutation.submit(
          intent({
            clientOrderId: 'delayed-protection',
            side: OrderSide.Sell,
            orderType: kind === 'Oco' ? OrderType.Limit : OrderType.StopLimit,
            limitPriceMicros: kind === 'Oco' ? '103000000' : '98900000',
            notionalLimitMicros: kind === 'Oco' ? '515000000' : '494500000',
            protection:
              kind === 'Oco'
                ? { ...bracketTerms, _tag: 'Oco', entryDecisionHash: 'a'.repeat(64) }
                : { _tag: 'StopLimit', stopPriceMicros: '99000000', entryDecisionHash: 'a'.repeat(64) },
          }),
        )
        const armed = yield* broker.checkpoint
        expect(armed.state.ledger.fills).toHaveLength(1)
        expect(
          armed.state.orders
            .filter(({ order }) => order.side === 'sell')
            .every(
              ({ order }) =>
                order.firstArrivedAt === new Date(startMs + 2000).toISOString() && order.stopTriggeredAt === undefined,
            ),
        ).toBe(true)
        broker = yield* makeReplayBroker({
          ...frozen,
          restoreCheckpoint: { value: armed, expectedHash: armed.checkpointHash },
        })
        yield* broker.observeMarket(startMs + 2100, laterMarket(2100, 99))
        yield* TestClock.setTime(startMs + 2100)
        const flat = yield* broker.checkpoint
        expect(flat.state.ledger.positions).toEqual([])
        expect(flat.state.ledger.fills.at(-1)?.observedAt).toBe(new Date(startMs + 2100).toISOString())
      }),
    )
  })
}

test('failed bracket delivery cancels held children without inventing an arrival', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        advanceToArrival: () => Effect.fail(new ReplayBrokerFailure({ message: 'routing failed' })),
      })
      expect((yield* Effect.exit(broker.mutation.submit(intent({ protection: bracketTerms }))))._tag).toBe('Failure')
      const checkpoint = yield* broker.checkpoint
      expect(checkpoint.state.orders).toHaveLength(3)
      expect(
        checkpoint.state.orders.every(
          ({ order }) => order.status === OrderStatus.Canceled && order.firstArrivedAt === undefined,
        ),
      ).toBe(true)
      expect(checkpoint.state.ledger.fills).toEqual([])
    }),
  )
})
