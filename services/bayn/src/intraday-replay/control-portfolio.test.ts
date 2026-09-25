import { expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { OrderSide } from '../execution/contracts'
import { canonicalHashV1 } from '../hash'
import { nativeJevFixture } from '../jev/native.test-support'
import type { IntradayQuote } from '../market-data/intraday/model'
import { compareRecords } from '../market-data/intraday/verification'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import { decideIntradayMomentumCore } from '../strategy/intraday-momentum/decision-core'
import { defaultIntradayMomentumProtocolDocument } from '../strategy/intraday-momentum/protocol'
import {
  applyControlOrder,
  controlEntryQuantity,
  ControlExit,
  ControlPolicy,
  createControlPortfolio,
  selectControlSymbol,
  triggerControlExit,
} from './control-portfolio'

const fixture = nativeJevFixture()
const at = Date.parse(fixture.observation.payload.observedAt)
const assumptions = { latencyMs: 100, slippageBps: 1, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 }
const original = fixture.snapshot.latestQuotes['AAPL']
if (original === undefined) throw new Error('Missing AAPL fixture')
const quote = (atMs: number, overrides: Partial<IntradayQuote> = {}) => {
  const value = {
    ...original,
    eventAt: new Date(atMs).toISOString(),
    ingestedAt: new Date(atMs).toISOString(),
    bidPrice: 100,
    askPrice: 100.02,
    bidSize: 1000,
    askSize: 1000,
    ...overrides,
  }
  return { value, sequence: 1, availableAtMs: atMs, recordHash: canonicalHashV1(value) }
}
const order = (side: OrderSide, atMs = at, shares = 10n) => ({
  symbol: 'AAPL',
  side,
  quantityMicros: shares * 1_000_000n,
  protocol: fixture.protocol,
  assumptions,
  decisionAtMs: atMs,
  arrivalAtMs: atMs + 100,
  decisionQuote: quote(atMs),
  arrivalQuote: quote(atMs + 100),
})
const flat = () => Result.getOrThrow(createControlPortfolio('100000000000'))
const entry = () => Result.getOrThrow(applyControlOrder(flat(), order(OrderSide.Buy))).portfolio
const exiting = () =>
  Result.getOrThrow(
    triggerControlExit({
      portfolio: entry(),
      policy: ControlPolicy.RelativeMomentum,
      protocol: fixture.protocol,
      atMs: at + 1_000_000,
      cutoffMs: at + 2_000_000,
      quote: quote(at + 1_000_000),
    }),
  )

test('control counts only flat-to-flat episodes and never overlaps capital', () => {
  const entered = entry()
  expect(entered.episodes).toHaveLength(0)
  expect(Result.isFailure(applyControlOrder(entered, order(OrderSide.Buy)))).toBeTrue()
  expect(Result.isFailure(applyControlOrder(entered, order(OrderSide.Sell)))).toBeTrue()
  const closed = Result.getOrThrow(applyControlOrder(exiting(), order(OrderSide.Sell, at + 1_000_000))).portfolio
  expect(closed.inventory.status).toBe('FLAT')
  expect(closed.episodes).toHaveLength(1)
  expect(closed.ledger.positions).toHaveLength(0)
  expect(closed.episodes[0]?.netExecutionPnlMicros).toBe(String(BigInt(closed.ledger.cashMicros) - 100_000_000_000n))
  const reentered = Result.getOrThrow(applyControlOrder(closed, order(OrderSide.Buy, at + 1_060_000))).portfolio
  expect(reentered.inventory.status).toBe('HOLDING')
  expect(reentered.episodes).toHaveLength(1)
})

test('partial entry and exit preserve inventory, original basis, trigger and one episode', () => {
  const buy = order(OrderSide.Buy)
  const partialEntry = Result.getOrThrow(
    applyControlOrder(flat(), { ...buy, arrivalQuote: quote(at + 100, { askSize: 4 }) }),
  ).portfolio
  expect(partialEntry.ledger.positions[0]?.quantityMicros).toBe('4000000')
  const triggered = Result.getOrThrow(
    triggerControlExit({
      portfolio: partialEntry,
      policy: ControlPolicy.RelativeMomentum,
      protocol: fixture.protocol,
      atMs: at + 1000,
      cutoffMs: at + 999,
      quote: quote(at + 1000),
    }),
  )
  const sell = order(OrderSide.Sell, at + 1000, 4n)
  const partialExit = Result.getOrThrow(
    applyControlOrder(triggered, { ...sell, arrivalQuote: quote(at + 1100, { bidSize: 1 }) }),
  ).portfolio
  expect(partialExit.episodes).toHaveLength(0)
  expect(partialExit.inventory).toEqual(triggered.inventory)
  expect(partialExit.ledger.positions[0]?.quantityMicros).toBe('3000000')
  const closed = Result.getOrThrow(applyControlOrder(partialExit, order(OrderSide.Sell, at + 2000, 3n))).portfolio
  expect(closed.episodes).toHaveLength(1)
  expect(closed.episodes[0]?.reason).toBe(ControlExit.SessionClose)
  expect(closed.ledger.fills.map((fill) => fill.quantityMicros)).toEqual(['4000000', '1000000', '3000000'])
})

test('canceled and missing-price exits remain pending until actual remaining shares fill', () => {
  const triggered = exiting()
  const sell = order(OrderSide.Sell, at + 1_000_000)
  const canceled = Result.getOrThrow(
    applyControlOrder(triggered, { ...sell, arrivalQuote: quote(at + 1_000_100, { bidPrice: 99, askPrice: 99.02 }) }),
  )
  expect(canceled.outcome.status).toBe('CANCELED')
  expect(canceled.portfolio).toEqual(triggered)
  const missing = Result.getOrThrow(applyControlOrder(triggered, { ...sell, arrivalQuote: undefined }))
  expect(missing.outcome.status).toBe('UNRESOLVED')
  expect(missing.portfolio).toEqual(triggered)
})

test('exit retries cannot replenish an unchanged quote liquidity budget', () => {
  let portfolio = exiting()
  const retained = quote(at + 1_000_100, { bidSize: 1 })
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const sell = order(
      OrderSide.Sell,
      at + 1_000_000 + attempt * 500,
      BigInt(portfolio.ledger.positions[0]?.quantityMicros ?? '0') / 1_000_000n,
    )
    portfolio = Result.getOrThrow(applyControlOrder(portfolio, { ...sell, arrivalQuote: retained })).portfolio
  }
  expect(portfolio.ledger.fills.filter((fill) => fill.side === 'sell')).toHaveLength(1)
  expect(portfolio.ledger.positions[0]?.quantityMicros).toBe('9000000')
  expect(portfolio.episodes).toHaveLength(0)
  const nextQuote = quote(at + 1_005_100, { bidSize: 1 })
  portfolio = Result.getOrThrow(
    applyControlOrder(portfolio, { ...order(OrderSide.Sell, at + 1_005_000, 9n), arrivalQuote: nextQuote }),
  ).portfolio
  expect(portfolio.ledger.positions[0]?.quantityMicros).toBe('8000000')
})

test('quote budgets preserve unspent liquidity and remain independent between counterfactual portfolios', () => {
  const retained = quote(at + 1_000_100, { bidSize: 3 })
  const first = {
    ...order(OrderSide.Sell, at + 1_000_000, 1n),
    arrivalQuote: retained,
    assumptions: { ...assumptions, availableLiquidityPpm: 500_000 },
  }
  const original = exiting()
  const once = Result.getOrThrow(applyControlOrder(original, first)).portfolio
  const again = Result.getOrThrow(
    applyControlOrder(once, { ...first, decisionAtMs: at + 1_000_500, arrivalAtMs: at + 1_000_600 }),
  ).portfolio
  expect(again.ledger.positions[0]?.quantityMicros).toBe('9000000')
  const independent = Result.getOrThrow(applyControlOrder(original, first)).portfolio
  expect(independent.ledger.positions[0]?.quantityMicros).toBe('9000000')

  const larger = quote(at + 1_000_100, { bidSize: 10 })
  const partial = Result.getOrThrow(
    applyControlOrder(original, { ...order(OrderSide.Sell, at + 1_000_000, 1n), arrivalQuote: larger }),
  ).portfolio
  const remaining = Result.getOrThrow(
    applyControlOrder(partial, { ...order(OrderSide.Sell, at + 1_000_500, 9n), arrivalQuote: larger }),
  ).portfolio
  expect(remaining.episodes).toHaveLength(1)
  expect(remaining.ledger.positions).toHaveLength(0)
})

test('mechanical stops require fresh quotes and retained policy holds until the close window', () => {
  const common = {
    portfolio: entry(),
    protocol: fixture.protocol,
    atMs: at + 1000,
    cutoffMs: at + 2_000_000,
    quote: quote(at + 1000, { bidPrice: 98, askPrice: 98.02 }),
  }
  expect(
    Result.getOrThrow(triggerControlExit({ ...common, policy: ControlPolicy.RelativeMomentum })).inventory,
  ).toMatchObject({ status: 'EXITING', reason: ControlExit.ProtectiveStop })
  expect(
    Result.getOrThrow(
      triggerControlExit({
        ...common,
        policy: ControlPolicy.RelativeMomentum,
        quote: quote(at - 20_000, { bidPrice: 98, askPrice: 98.02 }),
      }),
    ).inventory.status,
  ).toBe('HOLDING')
  expect(
    Result.getOrThrow(triggerControlExit({ ...common, atMs: at + 1_000_000, policy: ControlPolicy.RetainedBreakout }))
      .inventory.status,
  ).toBe('HOLDING')
  expect(
    Result.getOrThrow(triggerControlExit({ ...common, atMs: at + 2_000_000, policy: ControlPolicy.RetainedBreakout }))
      .inventory,
  ).toMatchObject({ status: 'EXITING', reason: ControlExit.SessionClose })
})

test('entry sizing obeys order and daily turnover bounds including the adverse limit and fees', async () => {
  const risk = await Effect.runPromise(loadQuoteBoundExecutionRiskPolicy('control-test', fixture.protocol.universe))
  const size = (portfolio = flat(), policy = risk, targetWeight = 0.2) =>
    Result.getOrThrow(
      controlEntryQuantity({
        portfolio,
        policy,
        protocol: fixture.protocol,
        targetWeight,
        symbol: 'AAPL',
        referencePriceMicros: 100_000_000n,
        atMs: at,
        feeMultiplierPpm: 1_000_000,
      }),
    )
  expect(size()).toBe(200_000_000n)
  expect(size({ ...flat(), tradedNotionalMicros: 199_950_000_000n })).toBe(0n)
  expect(size({ ...flat(), tradedNotionalMicros: 199_000_000_000n })).toBe(9_000_000n)
  expect(size(flat(), { ...risk, maxOrderNotionalMicros: '1000000000' })).toBe(9_000_000n)
  const cashBoundary = Result.getOrThrow(createControlPortfolio('100100000'))
  expect(size(cashBoundary, risk, 1)).toBe(0n)
  expect(
    Result.isFailure(
      controlEntryQuantity({
        portfolio: entry(),
        policy: risk,
        protocol: fixture.protocol,
        targetWeight: 0.2,
        symbol: 'AAPL',
        referencePriceMicros: 100_000_000n,
        atMs: at,
        feeMultiplierPpm: 1_000_000,
      }),
    ),
  ).toBeTrue()
})

test('control signal uses the full verified snapshot and rejects stale benchmark evidence', () => {
  expect(
    Result.getOrThrow(selectControlSymbol(fixture.snapshot, ControlPolicy.RelativeMomentum, fixture.protocol)),
  ).toBe('AAPL')
  const benchmark = fixture.snapshot.latestQuotes['SPY']
  if (benchmark === undefined) throw new Error('Missing SPY fixture')
  const stale = {
    ...fixture.snapshot,
    latestQuotes: {
      ...fixture.snapshot.latestQuotes,
      SPY: { ...benchmark, eventAt: new Date(at - 20_000).toISOString() },
    },
  }
  expect(Result.isFailure(selectControlSymbol(stale, ControlPolicy.RelativeMomentum, fixture.protocol))).toBeTrue()
})

test('retained breakout accepts a fresh benchmark quote when its trade is older than candidate freshness', () => {
  const later = nativeJevFixture(undefined, new Date(at + 30_000).toISOString())
  const observedAtMs = Date.parse(later.snapshot.manifest.observedAt)
  const snapshot = {
    ...later.snapshot,
    trades: later.snapshot.trades.map((trade) =>
      trade.symbol === 'SPY' ? { ...trade, eventAt: new Date(observedAtMs - 25_000).toISOString() } : trade,
    ),
  }
  const native = Result.getOrThrow(
    decideIntradayMomentumCore({
      observedAt: snapshot.manifest.observedAt,
      protocol: defaultIntradayMomentumProtocolDocument,
      latestQuotes: snapshot.latestQuotes,
      latestTrades: Object.fromEntries(snapshot.trades.toSorted(compareRecords).map((trade) => [trade.symbol, trade])),
      rollingPrices: Object.fromEntries(
        snapshot.manifest.streaming.features.map(({ value }) => [value.material.symbol, value.material.values]),
      ),
      candidateExclusions: snapshot.manifest.candidateExclusions ?? [],
    }),
  )
  expect(native.selectedSymbols).toEqual(['AAPL'])
  expect(Result.getOrThrow(selectControlSymbol(snapshot, ControlPolicy.RetainedBreakout, later.protocol))).toBe(
    native.selectedSymbols[0],
  )
  expect(Result.getOrThrow(selectControlSymbol(snapshot, ControlPolicy.RepeatedBreakout, later.protocol))).toBe(
    native.selectedSymbols[0],
  )
})

test('retained breakout preserves the native breakout tie-break after equal relative returns', () => {
  const tied = new Set(['AAPL', 'AMZN'])
  const snapshot = {
    ...fixture.snapshot,
    manifest: {
      ...fixture.snapshot.manifest,
      streaming: {
        ...fixture.snapshot.manifest.streaming,
        features: fixture.snapshot.manifest.streaming.features.map((feature) => {
          const material = feature.value.material
          return tied.has(material.symbol)
            ? {
                ...feature,
                value: {
                  ...feature.value,
                  material: {
                    ...material,
                    values: {
                      ...material.values,
                      referencePriceMicros: '100000000',
                      rangeHighPriceMicros: material.symbol === 'AAPL' ? '102000000' : '101000000',
                      rangeLowPriceMicros: '99000000',
                    },
                  },
                },
              }
            : feature
        }),
      },
    },
    latestQuotes: Object.fromEntries(
      Object.entries(fixture.snapshot.latestQuotes).map(([symbol, value]) => [
        symbol,
        tied.has(symbol) ? { ...value, bidPrice: 101.99, askPrice: 102.01 } : value,
      ]),
    ),
    trades: fixture.snapshot.trades.map((trade) => (tied.has(trade.symbol) ? { ...trade, price: 102.01 } : trade)),
  }
  expect(Result.getOrThrow(selectControlSymbol(snapshot, ControlPolicy.RetainedBreakout, fixture.protocol))).toBe(
    'AMZN',
  )
  expect(Result.getOrThrow(selectControlSymbol(snapshot, ControlPolicy.RepeatedBreakout, fixture.protocol))).toBe(
    'AMZN',
  )
})
