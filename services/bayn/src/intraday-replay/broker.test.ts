import { expect, test } from 'bun:test'
import { Effect, Exit, Fiber, Result, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { AssetClass, AssetExchange, AssetStatus, OrderCollection, OrderStatus } from '../broker/alpaca/model'
import { normalizeAssetResult } from '../broker/alpaca/normalizers'
import { IntentState, OrderSide, OrderType, TimeInForce, type Intent } from '../execution/contracts'
import { streamingFixture } from '../testing/streaming-market-fixture'
import { canonicalHashV1Result } from '../hash'
import type { IntradayQuote } from '../market-data/intraday/model'
import { makeReplayBroker, ReplayBrokerFailure, type ReplayBrokerConfig } from './broker'
import { positionSnapshot } from '../broker/observations'

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
      return yield* submit(broker, intent())
    }),
  )
  expect(result.order.status).toBe(OrderStatus.Canceled)
  expect(result.order.filledQuantityMicros).toBe('0')
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

test('next session uses recorded closing equity while retaining open positions', async () => {
  const closingMs = Date.parse('2026-09-04T20:00:00.000Z')
  const nextOpenMs = Date.parse('2026-09-08T13:30:00.000Z')
  const result = await run(
    Effect.gen(function* () {
      const broker = yield* setup({
        calendar: [...config.calendar, { date: '2026-09-08', open: '09:30', close: '16:00' }],
        quoteAt: (_symbol, time) => {
          const price = time >= nextOpenMs ? 102 : time >= closingMs ? 101 : 100
          return Effect.succeed(
            observedQuote({ ...quote, eventAt: new Date(time).toISOString(), bidPrice: price, askPrice: price }, time),
          )
        },
      })
      yield* submit(broker, intent())
      const earlyClose = yield* Effect.result(broker.completeSession('2026-09-04'))
      yield* TestClock.setTime(closingMs)
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
