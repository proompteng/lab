import { expect, test } from 'bun:test'
import { Clock, Deferred, Effect, Exit, Fiber, Result, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import {
  AssetClass,
  AssetExchange,
  AssetStatus,
  OrderCollection,
  OrderStatus,
  OrderType as BrokerOrderType,
  TimeInForce as BrokerTimeInForce,
} from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { IntentState, OrderSide, OrderType, TimeInForce, type Intent } from '../execution/contracts'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { canonicalHashV1Result } from '../hash'
import type { IntradayQuote } from '../market-data/intraday/model'
import { makeReplayBroker, ReplayBrokerFailure, type ReplayBrokerConfig } from './broker'
import { positionSnapshot } from '../broker/observations'
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
  calendar: [{ date: '2026-09-04', open: '09:30', close: '16:00' }],
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
  schemaVersion: 'bayn.paper-intent.v3',
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
  timeInForce: TimeInForce.ImmediateOrCancel,
  quantityMicros: '5000000',
  notionalLimitMicros: '505000000',
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

test('canceled IOC retains the actual arrival quote, modeled price and reason in its durable checkpoint', async () => {
  const checkpoint = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ assumptions: { ...config.assumptions, slippageBps: 1 } })
      yield* submit(broker, intent({ notionalLimitMicros: '500000000' }))
      return yield* broker.checkpoint
    }),
  )
  expect(checkpoint.state.orders[0]?.execution).toMatchObject({
    arrivedAt: '2026-09-04T14:31:00.100Z',
    quote: {
      eventAt: observedAt,
      availableAtMs: startMs,
      ageNanos: '100000000',
      askPrice: 100,
      askSize: 100,
      sourceOffset: quote.sourceOffset,
    },
    outcome: { status: 'canceled', reason: 'adverse-price-exceeds-limit', adversePriceMicros: '100010000' },
  })
  expect(checkpoint.state.orders[0]?.order.filledQuantityMicros).toBe('0')
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

test('measured Jev submission follows final authorization and prices quotes available after source synchronization', async () => {
  const result = await run(
    Effect.gen(function* () {
      yield* TestClock.setTime(startMs)
      const providerClock = yield* TestClock.make()
      yield* providerClock.setTime(0)
      const timing = yield* makeReplayJevTiming({
        measureDatabaseTime: (operation) => operation,
        provider: { evaluate: () => Effect.die('This timing case does not need inference') },
        providerClock,
        retain: () => Effect.void,
        advanceTo: (at) => TestClock.setTime(at).pipe(Effect.andThen(providerClock.adjust(100))),
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
          const submitted = yield* broker.mutation.submit(intent())
          return { authorizedAt, order: submitted.order, checkpoint: yield* broker.checkpoint, lastArrival }
        }),
      )
      return { ...completed, marketAfter: yield* Clock.currentTimeMillis }
    }),
  )
  const submittedAt = result.order.submittedAt
  if (submittedAt === undefined) throw new Error('Measured replay order is missing its submission time')
  expect(Date.parse(result.authorizedAt)).toBe(startMs + 100)
  expect(Date.parse(submittedAt)).toBeGreaterThanOrEqual(Date.parse(result.authorizedAt))
  expect(Date.parse(submittedAt)).toBe(startMs + 300)
  expect(result.lastArrival).toBe(Date.parse(submittedAt) + 10)
  expect(result.marketAfter).toBe(result.lastArrival + 100)
  expect(result.order.filledAveragePriceMicros).toBe('100500000')
  expect(result.checkpoint.state.orders[0]?.execution?.quote?.availableAtMs).toBe(startMs + 100)
})

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

test('arrival quote drives partial IOC fill and the remainder is canceled once', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        quoteAt: (_symbol, time) =>
          Effect.succeed(observedQuote({ ...quote, askPrice: time >= startMs + 100 ? 100.5 : 100, askSize: 2 })),
      })
      const filled = yield* submit(broker, intent())
      const duplicate = yield* broker.mutation.submit(intent())
      const conflict = yield* Effect.result(broker.mutation.submit(intent({ notionalLimitMicros: '510000000' })))
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
  expect(result.filled.order.status).toBe(OrderStatus.Canceled)
  expect(result.filled.order.filledQuantityMicros).toBe('2000000')
  expect(result.filled.order.filledAveragePriceMicros).toBe('100500000')
  expect(result.duplicate.order.brokerOrderId).toBe(result.filled.order.brokerOrderId)
  expect(Result.isFailure(result.conflict)).toBe(true)
  expect(result.state.ledger.fills).toHaveLength(1)
  expect(result.fills.items).toHaveLength(1)
  expect(result.positions[0]?.quantityMicros).toBe('2000000')
  expect(result.account.cashMicros).toBe(result.state.ledger.cashMicros)
  expect(result.state.ledger.fills[0]?.quoteSource.offset).toBe(quote.sourceOffset)
  expect(result.state.orders[0]?.execution?.outcome).toMatchObject({
    status: 'filled',
    filledQuantityMicros: '2000000',
    fillPriceMicros: '100500000',
    unfilledRemainder: 'canceled',
  })
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
        intent({ clientOrderId: 'replay-sell-1', side: OrderSide.Sell, notionalLimitMicros: '500000000' }),
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

test.each(['stale', 'future', 'crossed', 'other-feed'] as const)('%s quote cannot fill an order', async (kind) => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        quoteAt: () =>
          Effect.succeed(
            observedQuote(
              {
                ...quote,
                eventAt: kind === 'stale' ? '2026-09-04T14:30:00.000Z' : observedAt,
                bidPrice: kind === 'crossed' ? 102 : 100,
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
  expect(result.receipt.order.status).toBe(OrderStatus.Canceled)
  expect(result.receipt.order.filledQuantityMicros).toBe('0')
  const reasons = {
    stale: ReplayQuoteRejection.Stale,
    future: ReplayQuoteRejection.Unavailable,
    crossed: ReplayQuoteRejection.Price,
    'other-feed': ReplayQuoteRejection.Identity,
  }
  expect(result.checkpoint.state.orders[0]?.execution?.outcome).toEqual({
    status: 'canceled',
    reason: reasons[kind],
    adversePriceMicros: null,
  })
})

test.each(['oversell', 'cash'] as const)('%s rejection is terminal and recoverable by client ID', async (kind) => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({ openingCashMicros: kind === 'cash' ? '1000000' : config.openingCashMicros })
      const order = intent({
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
  expect(result.state.orders[0]?.execution?.outcome).toEqual({
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
      const result = yield* broker.completeSession('2026-09-04').pipe(Effect.result)
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
          calendar: [...config.calendar, { date: '2026-09-08', open: '09:30', close: '16:00' }],
          quoteAt: (_symbol, time) => {
            const price = time > closingMs ? 102 : time === closingMs ? 101 : 100
            return Effect.succeed(
              observedQuote(
                { ...quote, eventAt: new Date(time).toISOString(), bidPrice: price, askPrice: price },
                time,
              ),
            )
          },
        })
        yield* submit(broker, intent())
        const earlyClose = yield* Effect.result(broker.completeSession('2026-09-04'))
        yield* TestClock.setTime(closingMs + elapsedMs)
        const close = yield* broker.completeSession('2026-09-04')
        const repeatedClose = yield* broker.completeSession('2026-09-04')
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
    expect(result.positions[0]?.quantityMicros).toBe('5000000')
  },
)

test('delayed close selects the retained projection quote available at close', async () => {
  const closingMs = Date.parse('2026-09-04T20:00:00.000Z')
  const universe = {
    universeId: protocol.universeId,
    universeSymbolHash: protocol.universeSymbolHash,
    symbols: protocol.universe,
    topics: { ...protocol.sourceTopics, features: 'torghut.market-features.v1' },
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
        quoteAt: (symbol, atMs) => Effect.sync(() => observedQuoteAt(projection, symbol, atMs)),
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
      const close = yield* broker.completeSession('2026-09-04')
      const state = yield* broker.snapshot
      expect(close.equityMicros).toBe((BigInt(state.ledger.cashMicros) + 505_000_000n).toString())
      expect(state.ledger.positions[0]?.quantityMicros).toBe('5000000')
      expect(state.fills).toHaveLength(1)
    }),
  )
})

test('missing session close prevents a fabricated next-day equity baseline', async () => {
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        calendar: [...config.calendar, { date: '2026-09-08', open: '09:30', close: '16:00' }],
      })
      yield* TestClock.setTime(Date.parse('2026-09-08T13:30:00.000Z'))
      return yield* Effect.result(broker.read.account)
    }),
  )
  expect(Result.isFailure(result)).toBe(true)
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
  expect(result.state.orders[1]?.execution?.outcome).toMatchObject({
    status: 'canceled',
    reason: ReplayQuoteRejection.Stale,
  })
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
  'IOC arriving at or beyond close expires at close with latency %d and preserves closing equity',
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
          quoteAt: () => Effect.die(new Error('An expired IOC must not read an execution quote')),
        })
        yield* TestClock.setTime(latencyMs === 0 ? close : close - 30_000)
        const receipt = yield* broker.mutation.submit(intent())
        const closing = yield* broker.completeSession('2026-09-04')
        const duplicate = yield* broker.mutation.submit(intent())
        return { receipt, duplicate, closing, atMs: yield* Clock.currentTimeMillis, state: yield* broker.snapshot }
      }),
    )
    expect(arrivals).toEqual([close])
    expect(result.atMs).toBe(close)
    expect(result.receipt.order.status).toBe(OrderStatus.Canceled)
    expect(result.receipt.order.canceledAt).toBe('2026-09-04T20:00:00.000Z')
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

test('checkpoint cannot claim pending IOC delivery survived a process restart', async () => {
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
      yield* broker.completeSession('2026-09-04')
      const checkpoint = yield* broker.checkpoint
      const { checkpointHash: _hash, ...material } = checkpoint
      const altered = {
        ...material,
        state: { ...material.state, sessionCloses: [{ sessionDate: '2026-09-04', equityMicros: '1' }] },
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
              order: {
                ...order,
                canceledAt: checkpoint.observedAt,
                filledQuantityMicros: '0',
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
      expect((yield* Effect.exit(broker.completeSession('2026-09-04')))._tag).toBe('Failure')
      expect((yield* broker.snapshot).sessionCloses).toEqual([])
    }),
  )
})

test('production MARKET/DAY close liquidates at the adverse arrival price and survives restore', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        advanceToArrival: (at) => TestClock.setTime(at),
        assumptions: { ...config.assumptions, slippageBps: 1 },
      })
      yield* broker.mutation.submit(intent())
      const close = intent({
        clientOrderId: 'market-close',
        side: OrderSide.Sell,
        orderType: OrderType.Market,
        timeInForce: TimeInForce.Day,
        notionalLimitMicros: '1',
      })
      const result = yield* broker.mutation.submit(close, true)
      expect(result.order.orderType).toBe(BrokerOrderType.Market)
      expect(result.order.timeInForce).toBe(BrokerTimeInForce.Day)
      expect(result.order.limitPriceMicros).toBeUndefined()
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

test('fractional market closes preserve residual inventory, fees, and restart evidence', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({ fractionalTrading: true, advanceToArrival: (at) => TestClock.setTime(at) })
      yield* broker.mutation.submit(intent())
      for (const [index, quantityMicros] of ['500000', '4500000'].entries()) {
        const closed = yield* broker.mutation.submit(
          intent({
            clientOrderId: `fractional-close-${index}`,
            side: OrderSide.Sell,
            orderType: OrderType.Market,
            timeInForce: TimeInForce.Day,
            quantityMicros,
            notionalLimitMicros: '1',
          }),
          true,
        )
        expect(closed.order.filledQuantityMicros).toBe(quantityMicros)
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
  test(`market close with ${scenario} arrival evidence fails the simulation without fabricated fills`, async () => {
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
        const rejected = yield* Effect.exit(
          broker.mutation.submit(
            intent({
              clientOrderId: 'failed-market-close',
              side: OrderSide.Sell,
              orderType: OrderType.Market,
              timeInForce: TimeInForce.Day,
            }),
            true,
          ),
        )
        expect(rejected._tag).toBe('Failure')
        const state = yield* broker.snapshot
        expect(state.fills).toHaveLength(1)
        expect(state.ledger.positions[0]?.quantityMicros).toBe('5000000')
        expect(state.orders[1]?.deliveryFailure).toBeDefined()
        yield* TestClock.setTime(Date.parse('2026-09-04T20:00:00Z'))
        expect((yield* Effect.exit(broker.completeSession('2026-09-04')))._tag).toBe('Failure')
      }),
    )
  })
}

test('fractional market close requires the captured account fractional-trading setting', async () => {
  await run(
    Effect.gen(function* () {
      const broker = yield* setup({ fractionalTrading: false, advanceToArrival: (at) => TestClock.setTime(at) })
      yield* broker.mutation.submit(intent())
      const close = intent({
        clientOrderId: 'disabled-fractional-close',
        side: OrderSide.Sell,
        orderType: OrderType.Market,
        timeInForce: TimeInForce.Day,
        quantityMicros: '500000',
      })
      expect((yield* Effect.exit(broker.mutation.submit(close, true)))._tag).toBe('Failure')
      expect((yield* broker.snapshot).orders).toHaveLength(1)
    }),
  )
})
