import { expect, test } from 'bun:test'
import { Result, Schema } from 'effect'

import { coinRoundTrip } from '../forward-performance/coin-fee-episodes.test-support'
import type { ForwardPerformanceEvidenceInput } from '../forward-performance/model'
import type { IntradayQuote } from '../market-data/intraday/model'
import type { ObservedMarketValue } from '../market-data/streaming/projection'
import { AccountMarkSchema, accountMarkValue, prepareValuationInventory } from './valuation'
import { executableValuationQuote } from './valuation-quotes'
import { testHash } from './fixtures.test-support'
import { capturedAccountsFixture } from './source-cut.test-support'
import { bindSystemSourceCut } from './bind-source'
import { currentEquityMarketProfile, equityMarketProfile } from '../jev/markets'

const executableBid = (
  quote: ObservedMarketValue<IntradayQuote> | undefined,
  symbol: string,
  at: string,
  age: number,
) => executableValuationQuote(quote, symbol, at, age, equityMarketProfile, '1')

const mark = {
  accountBindingHash: testHash('account'),
  sourceHash: testHash('cash'),
  at: '2026-09-18T15:30:01.000Z',
  availableAt: '2026-09-18T15:30:01.000Z',
  cashMicros: '100',
  valuation: {
    inventorySourceHash: testHash('inventory'),
    positions: [
      {
        symbol: 'AAPL',
        quantityAtoms: '1500000001',
        bidPriceMicros: '100000001',
        costBasisMicros: '150000000',
        quoteSourceHash: testHash('quote'),
      },
    ],
  },
}

test('bid marks conserve cash plus inventory and round down each position without using broker equity', () => {
  expect(accountMarkValue(mark)).toEqual({ equityMicros: '150000101', unrealizedPnlMicros: '1', positionCount: 1 })
  expect(accountMarkValue({ ...mark, cashMicros: '-100' })?.equityMicros).toBe('149999901')
  expect(accountMarkValue({ ...mark, valuation: { ...mark.valuation, positions: [] } })).toEqual({
    equityMicros: '100',
    unrealizedPnlMicros: '0',
    positionCount: 0,
  })
  expect(accountMarkValue({ ...mark, valuation: null })).toBeNull()
  expect(
    accountMarkValue({
      ...mark,
      valuation: {
        ...mark.valuation,
        positions: mark.valuation.positions.map((p) => ({ ...p, costBasisMicros: '200000000' })),
      },
    })?.unrealizedPnlMicros,
  ).toBe('-49999999')

  expect(
    accountMarkValue({
      ...mark,
      valuation: { ...mark.valuation, positions: [...mark.valuation.positions, ...mark.valuation.positions] },
    }),
  ).toBeNull()
  for (const override of [{ quantityAtoms: '0' }, { bidPriceMicros: '0' }])
    expect(
      accountMarkValue({
        ...mark,
        valuation: {
          ...mark.valuation,
          positions: mark.valuation.positions.map((position) => ({ ...position, ...override })),
        },
      }),
    ).toBeNull()
})

const quote: ObservedMarketValue<IntradayQuote> = {
  availableAtMs: Date.parse(mark.at),
  sequence: 1,
  recordHash: testHash('retained quote'),
  value: {
    provider: 'alpaca',
    universeId: equityMarketProfile.universeId,
    universeSymbolHash: equityMarketProfile.universeSymbolHash,
    feed: 'iex',
    delayClass: 'real_time_exchange_only',
    marketSession: 'regular',
    symbol: 'AAPL',
    schemaVersion: 1,
    eventAt: mark.at,
    ingestedAt: mark.at,
    sourceTopic: equityMarketProfile.sourceTopics.quotes,
    sourcePartition: 0,
    sourceOffset: '1',
    bidPrice: 100.0000009,
    askPrice: 101,
    bidSize: 100,
    askSize: 100,
  },
}

test('executable marks use causal fresh bids with positive liquidity and conservative price precision', () => {
  expect(executableBid(quote, 'AAPL', mark.at, 10_000)).toEqual({
    bidPriceMicros: '100000000',
    quoteSourceHash: quote.recordHash,
  })
  expect(executableBid(quote, 'AAPL', '2026-09-18T15:30:11.000Z', 10_000)).not.toBeNull()
  expect(executableBid(quote, 'AAPL', '2026-09-18T15:30:11.001Z', 10_000)).toBeNull()
  expect(executableBid(undefined, 'AAPL', mark.at, 10_000)).toBeNull()
  expect(executableBid(quote, 'MSFT', mark.at, 10_000)).toBeNull()
  expect(executableBid({ ...quote, availableAtMs: quote.availableAtMs + 1 }, 'AAPL', mark.at, 10_000)).toBeNull()
  for (const change of [
    { eventAt: '2026-09-18T15:30:01.000000001Z' },
    { bidSize: 0 },
    { bidSize: -1 },
    { bidPrice: 102 },
    { askPrice: Infinity },
  ])
    expect(executableBid({ ...quote, value: { ...quote.value, ...change } }, 'AAPL', mark.at, 10_000)).toBeNull()
})

test('registered v3 marks accept their exact universe and price short liabilities at the executable ask', () => {
  const current = {
    ...quote,
    value: {
      ...quote.value,
      universeId: currentEquityMarketProfile.universeId,
      universeSymbolHash: currentEquityMarketProfile.universeSymbolHash,
      askPrice: 101.0000001,
    },
  }
  const value = (
    q: ObservedMarketValue<IntradayQuote> = current,
    profile = currentEquityMarketProfile,
    quantity = '-1500000001',
  ) => executableValuationQuote(q, 'AAPL', mark.at, 10000, profile, quantity)
  expect(value()).toEqual({ askPriceMicros: '101000001', quoteSourceHash: quote.recordHash })
  expect(value(current, currentEquityMarketProfile, '1')).toEqual({
    bidPriceMicros: '100000000',
    quoteSourceHash: quote.recordHash,
  })
  expect(executableValuationQuote(current, 'AAPL', mark.at, 10000, equityMarketProfile, '1')).toBeNull()
  expect(value(quote)).toBeNull()
  expect(value({ ...current, value: { ...current.value, universeSymbolHash: testHash('wrong universe') } })).toBeNull()
  expect(value({ ...current, value: { ...current.value, askSize: 0 } })).toBeNull()
  expect(value({ ...current, availableAtMs: quote.availableAtMs + 1 })).toBeNull()
  expect(executableValuationQuote(current, 'AAPL', mark.at, 10000, undefined, '-1')).toBeNull()
})

test('signed account marks subtract ask-side cover liabilities with conservative rounding and reject direction drift', () => {
  const short = {
    symbol: 'AAPL',
    quantityAtoms: '-1500000001',
    askPriceMicros: '100000001',
    costBasisMicros: '-150000000',
    quoteSourceHash: testHash('short quote'),
  }
  const shortMark = Schema.decodeUnknownSync(AccountMarkSchema)({
    ...mark,
    cashMicros: '200000000',
    valuation: { ...mark.valuation, positions: [short] },
  })
  expect(accountMarkValue(shortMark)).toEqual({ equityMicros: '49999998', unrealizedPnlMicros: '-2', positionCount: 1 })
  for (const change of [
    { quantityAtoms: '1500000001' },
    { costBasisMicros: '150000000' },
    { askPriceMicros: '0' },
    { symbol: 'BTC/USD' },
  ])
    expect(
      accountMarkValue({ ...shortMark, valuation: { ...shortMark.valuation!, positions: [{ ...short, ...change }] } }),
    ).toBeNull()
  expect(
    accountMarkValue({
      ...shortMark,
      valuation: { ...shortMark.valuation!, positions: [short, mark.valuation.positions[0]!] },
    }),
  ).toBeNull()
})

test('a later coin settlement cannot invent the earlier inventory debit instant or deduct it twice', () => {
  const { fills, accrual } = coinRoundTrip()
  const cut = '2026-09-18T21:00:00.000Z'
  const forward: ForwardPerformanceEvidenceInput = {
    runtime: {
      sourceRevision: 'a'.repeat(40),
      imageRepository: 'test/bayn',
      imageDigest: `sha256:${testHash('image')}`,
    },
    account: {
      accountId: 'episode-account',
      accountReferenceHash: testHash('account'),
      provider: 'alpaca',
      environment: 'sandbox',
    },
    durableExecutionBindings: [],
    cycles: [],
    transactions: fills.map((fill) => ({ ...fill, cycleId: testHash('cycle') })),
    accountTransactions: fills,
    accountFeeAccruals: [accrual],
    accountBrokerFees: [],
    reconciliation: {
      reconciliationId: testHash('reconciliation'),
      contentHash: testHash('content'),
      status: 'EXACT',
      performanceExact: true,
      cashYieldAdjustedExact: false,
      reconciledAt: cut,
    },
    accountPositionCounts: { postgres: 0, ledger: 0, reconciledAt: cut, exact: true },
    accountingReceiptsExact: true,
    ledgerExact: true,
    missingLedgerAccountCount: 0,
    cashYieldEvidenceRequired: false,
    unresolvedMutationCount: 0,
    unclosedCycleCount: 0,
    openPositionCount: 0,
  }
  const inventory = Result.getOrThrow(prepareValuationInventory(forward))
  expect(inventory.at('2026-09-18T15:30:00.000Z')).toEqual([])
  expect(inventory.at('2026-09-18T15:30:01.000Z')).toBeNull()
  expect(inventory.at(accrual.data.observedAt)).toEqual([
    { symbol: 'ETH/USD', quantityAtoms: '32967375', costBasisMicros: '3296738' },
  ])
  expect(inventory.at('2026-09-18T15:30:03.000Z')).toEqual([])
  // Repeated and earlier independent endpoint queries cannot retain a later inventory state.
  expect(inventory.at('2026-09-18T15:30:01.500Z')).toBeNull()
  expect(inventory.at(accrual.data.observedAt)).toEqual([
    { symbol: 'ETH/USD', quantityAtoms: '32967375', costBasisMicros: '3296738' },
  ])
  expect(inventory.at(accrual.data.observedAt)).toEqual(inventory.at(accrual.data.observedAt))
  expect(inventory.at('2026-09-18T15:30:00.000Z')).toEqual([])
  expect(inventory.at('2026-09-18T21:00:00.001Z')).toBeNull()
  expect(Result.getOrThrow(prepareValuationInventory({ ...forward, ledgerExact: false })).at(mark.at)).toBeNull()
})

test('one unvalued captured observation cannot be removed from an otherwise profitable marked path', () => {
  const { input, cut, verifiedSources } = capturedAccountsFixture()
  const first = cut.accountMarks[0]
  if (first === undefined) throw new Error('Missing mark fixture')
  const changed = {
    ...cut,
    accountMarks: [
      ...cut.accountMarks,
      { ...first, at: new Date(Date.parse(first.at) + 30_000).toISOString(), valuation: null },
    ],
  }
  const bound = Result.getOrThrow(
    bindSystemSourceCut({ ...input, sourceCutHash: testHash(changed) }, changed, verifiedSources),
  )
  expect(bound.input.policies[0]?.sessions[0]?.marks).toEqual([])
  expect(bound.input.policies[0]?.sessions[0]?.financial).not.toBeNull()
})
