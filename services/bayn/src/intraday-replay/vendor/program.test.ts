import { NodeFileSystem } from '@effect/platform-node'
import { describe, expect, test } from 'bun:test'
import { Effect, Result } from 'effect'

import { canonicalHashV1, sha256 } from '../../hash'
import { utcInstantFromEpochMillis } from '../../time'
import { loadQuoteBoundExecutionRiskPolicy } from '../../observe-composition/decision-builder'
import { activeStrategyBehaviorHash, activeStrategyName } from '../../strategy'
import {
  decodeDefaultIntradayMomentumProtocol,
  hashIntradayMomentumProtocol,
  intradayMomentumSnapshotSymbols,
} from '../../strategy/intraday-momentum/protocol'
import { makeStrategyProtocolHashResult } from '../../contracts'
import {
  AlpacaHistoricalKind,
  type AlpacaHistoricalClient,
  type AlpacaHistoricalQuery,
  type VendorHistoricalCapture,
  type VendorHistoricalCaptureBase,
  type VendorHistoricalProvenance,
  type VendorHistoricalQuote,
  type VendorHistoricalRow,
} from './alpaca/model'
import { runVendorIntradayReplay } from './program'
import type { VendorReplayInput, VendorReplayReport } from './model'

const protocol = Result.getOrThrow(decodeDefaultIntradayMomentumProtocol())
const symbols = intradayMomentumSnapshotSymbols(protocol)
const parameterHash = Result.getOrThrow(hashIntradayMomentumProtocol(protocol))
const strategyProtocolHash = Result.getOrThrow(
  makeStrategyProtocolHashResult({
    name: activeStrategyName,
    behaviorHash: activeStrategyBehaviorHash,
    parameterHash,
    parameterSchemaVersion: protocol.schemaVersion,
  }),
)
const riskPolicy = Effect.runSync(loadQuoteBoundExecutionRiskPolicy('build-contract', protocol.universe))
const riskPolicyHash = canonicalHashV1(riskPolicy)

const firstPollDelayMs = 2_000
const orderLatencyMs = 100
const initialCapitalMicros = '100000000000'

type ReplayDate = VendorReplayInput['range']['start']

const inputFor = (
  dates: readonly ReplayDate[] = ['2026-08-18'],
  overrides: Partial<VendorReplayInput['scenarios'][number]['assumptions']> = {},
): VendorReplayInput => {
  const firstDate = dates[0]
  const lastDate = dates[dates.length - 1]
  if (firstDate === undefined || lastDate === undefined) throw new Error('test calendar must be non-empty')
  return {
    schemaVersion: 'bayn.vendor-intraday-replay-input.v1',
    experimentPlanHash: 'f'.repeat(64),
    strategyProtocolHash,
    behaviorHash: activeStrategyBehaviorHash,
    parameterHash,
    riskPolicyHash,
    range: { start: firstDate, end: lastDate },
    calendar: dates.map((date) => ({ date, open: '09:30', close: '16:00' })),
    initialCapitalMicros,
    allocationCapitalMicros: initialCapitalMicros,
    scenarios: [
      {
        name: 'baseline',
        assumptions: {
          pollIntervalMs: 30_000,
          firstPollDelayMs,
          orderLatencyMs,
          availableLiquidityPpm: 1_000_000,
          slippageBps: 0,
          feeMultiplierPpm: 1_000_000,
          ...overrides,
        },
      },
    ],
  }
}

interface HistoricalFixtureOptions {
  readonly decisionAaplMidpoint?: number
  readonly planningAsk?: number
  readonly arrivalAsk?: number
  readonly historyBid?: number
  readonly firstSessionRiskExcursion?: boolean
  readonly missingBars?: boolean
  readonly missingHistory?: boolean
  readonly cancelCloseAtArrival?: boolean
  readonly crossedCloseEvidence?: boolean
  readonly mismatchedCaptureQuery?: boolean
}

interface FixtureClient {
  readonly client: AlpacaHistoricalClient
  readonly calls: AlpacaHistoricalQuery[]
}

const quoteRow = (symbol: string, eventAt: string, midpoint: number, bidSize = 10_000): VendorHistoricalQuote => ({
  symbol,
  eventAt,
  bidPrice: midpoint - 0.01,
  bidSize,
  askPrice: midpoint + 0.01,
  askSize: bidSize,
  bidExchange: 'IEXG',
  askExchange: 'IEXG',
  conditions: [],
  tape: 'A',
})

const makeCapture = (query: AlpacaHistoricalQuery, rows: readonly VendorHistoricalRow[]): VendorHistoricalCapture => {
  const queryHash = sha256(JSON.stringify(query))
  const rowCountsBySymbol = Object.fromEntries(
    query.symbols.map((symbol) => [symbol, rows.filter((row) => row.symbol === symbol).length]),
  )
  const endpointPath: VendorHistoricalProvenance['endpointPath'] =
    query.kind === AlpacaHistoricalKind.Bars
      ? '/v2/stocks/bars'
      : query.kind === AlpacaHistoricalKind.Quotes
        ? '/v2/stocks/quotes'
        : '/v2/stocks/trades'
  const provenance = {
    schemaVersion: 'bayn.vendor-historical-provenance.v1' as const,
    source: 'alpaca-historical' as const,
    endpointPath,
    feed: 'iex' as const,
    asof: query.sessionDate,
    marketSession: 'regular' as const,
    timeBasis: 'event-time-only' as const,
    completeness: 'complete' as const,
    sessionDate: query.sessionDate,
    requestedSymbols: query.symbols,
    queryHash,
    normalizedHash: sha256(JSON.stringify(rows)),
    rowCountsBySymbol,
    pageReceipts: [],
    cacheKey: queryHash,
    retrievedAt: '2026-09-01T00:00:00.000Z',
  }
  const base: VendorHistoricalCaptureBase = {
    query,
    queryHash,
    provenance,
    provenanceHash: canonicalHashV1(provenance),
  }
  if (query.kind === AlpacaHistoricalKind.Bars) {
    return {
      ...base,
      kind: 'bars',
      rows: rows.filter((row): row is Extract<VendorHistoricalRow, { readonly open: number }> => 'open' in row),
    }
  }
  if (query.kind === AlpacaHistoricalKind.Quotes) {
    return {
      ...base,
      kind: 'quotes',
      rows: rows.filter((row): row is Extract<VendorHistoricalRow, { readonly bidPrice: number }> => 'bidPrice' in row),
    }
  }
  return {
    ...base,
    kind: 'trades',
    rows: rows.filter(
      (row): row is Extract<VendorHistoricalRow, { readonly providerTradeId: string }> => 'providerTradeId' in row,
    ),
  }
}

const makeFixtureClient = (options: HistoricalFixtureOptions = {}): FixtureClient => {
  const calls: AlpacaHistoricalQuery[] = []
  const entryArrivalServedFor = new Set<string>()
  const cachedCaptures = new Map<string, VendorHistoricalCapture>()
  const client: AlpacaHistoricalClient = {
    capture: (query) => {
      calls.push(query)
      const queryHash = sha256(JSON.stringify(query))
      const cached = cachedCaptures.get(queryHash)
      if (cached !== undefined) return Effect.succeed(cached)
      const openMs = Date.parse(query.sessionOpenAt)
      const closeMs = Date.parse(query.sessionCloseAt)
      const decisionAt = openMs + 60 * 60_000 + firstPollDelayMs
      const arrivalAt = decisionAt + orderLatencyMs
      const hardFlatAt = closeMs - protocol.hardFlatBeforeCloseMinutes * 60_000
      const closeStartAt = closeMs - protocol.flattenBeforeCloseMinutes * 60_000 + firstPollDelayMs
      let rows: readonly VendorHistoricalRow[]

      if (query.kind === AlpacaHistoricalKind.Bars) {
        rows = options.missingBars
          ? []
          : query.symbols.flatMap((symbol) => {
              const symbolOffset = symbols.indexOf(symbol)
              return Array.from({ length: Math.max(0, (Date.parse(query.endAt) - openMs) / 60_000) }, (_, minute) => ({
                symbol,
                eventAt: utcInstantFromEpochMillis(openMs + minute * 60_000),
                open: 100,
                high: 100.2 + Math.max(0, symbolOffset) * 0.01,
                low: 99.9,
                close: 100,
                volume: 1_000,
                vwap: 100,
                tradeCount: 100,
              }))
            })
      } else if (query.kind === AlpacaHistoricalKind.Trades) {
        const eventAt = utcInstantFromEpochMillis(Date.parse(query.endAt) - 1)
        rows = query.symbols.map((symbol) => ({
          symbol,
          eventAt,
          providerTradeId: `${symbol}-${eventAt}`,
          price: symbol === 'AAPL' ? (options.decisionAaplMidpoint ?? 101) : 100.01,
          size: 100,
          exchange: 'IEXG',
          conditions: [],
          tape: 'A',
        }))
      } else if (options.missingHistory && Date.parse(query.endAt) === arrivalAt + 30_000) {
        rows = []
      } else if (query.symbols.length === symbols.length) {
        const eventAt = utcInstantFromEpochMillis(Date.parse(query.endAt) - 1)
        rows = query.symbols.map((symbol) =>
          quoteRow(symbol, eventAt, symbol === 'AAPL' ? (options.decisionAaplMidpoint ?? 101) : 100.01),
        )
      } else if (Date.parse(query.endAt) === decisionAt) {
        rows = query.symbols.map((symbol) => quoteRow(symbol, utcInstantFromEpochMillis(decisionAt - 1), 100.005))
        if (query.symbols.includes('AAPL')) {
          rows = [quoteRow('AAPL', utcInstantFromEpochMillis(decisionAt - 1), (options.planningAsk ?? 101.01) - 0.01)]
        }
      } else if (Date.parse(query.endAt) === arrivalAt && !entryArrivalServedFor.has(query.sessionDate)) {
        entryArrivalServedFor.add(query.sessionDate)
        rows = query.symbols.map((symbol) => quoteRow(symbol, utcInstantFromEpochMillis(arrivalAt - 1), 100.005))
        if (query.symbols.includes('AAPL')) {
          rows = [quoteRow('AAPL', utcInstantFromEpochMillis(arrivalAt - 1), (options.arrivalAsk ?? 101.01) - 0.01)]
        }
      } else if (
        options.crossedCloseEvidence &&
        Date.parse(query.endAt) >= closeStartAt &&
        Date.parse(query.endAt) < hardFlatAt &&
        (Date.parse(query.endAt) - closeStartAt) % 30_000 === 0
      ) {
        rows = query.symbols.map((symbol) => ({
          ...quoteRow(symbol, utcInstantFromEpochMillis(Date.parse(query.endAt) - 100), 102),
          bidPrice: 102.01,
          askPrice: 102,
        }))
      } else if (
        Date.parse(query.endAt) >= closeStartAt &&
        Date.parse(query.endAt) < hardFlatAt &&
        (Date.parse(query.endAt) - closeStartAt) % 30_000 === 0
      ) {
        const bid = options.cancelCloseAtArrival ? 101 : (options.historyBid ?? 102)
        rows = query.symbols.map((symbol) =>
          quoteRow(symbol, utcInstantFromEpochMillis(Date.parse(query.endAt) - 100), bid),
        )
      } else if (
        Date.parse(query.endAt) > closeStartAt &&
        Date.parse(query.endAt) < hardFlatAt &&
        (Date.parse(query.endAt) - closeStartAt - orderLatencyMs) % 30_000 === 0
      ) {
        const bid = options.cancelCloseAtArrival ? 100 : (options.historyBid ?? 102)
        rows = query.symbols.map((symbol) =>
          quoteRow(symbol, utcInstantFromEpochMillis(Date.parse(query.endAt) - 1), bid),
        )
      } else if (
        options.firstSessionRiskExcursion &&
        query.sessionDate === '2026-08-18' &&
        Date.parse(query.endAt) === arrivalAt + 30_000
      ) {
        rows = query.symbols.map((symbol) =>
          quoteRow(symbol, utcInstantFromEpochMillis(Date.parse(query.endAt) - 100), 1),
        )
      } else if (
        Date.parse(query.endAt) >= arrivalAt &&
        Date.parse(query.endAt) <= hardFlatAt &&
        (Date.parse(query.endAt) - arrivalAt) % 30_000 === 0
      ) {
        rows = query.symbols.map((symbol) =>
          quoteRow(symbol, utcInstantFromEpochMillis(Date.parse(query.endAt) - 100), options.historyBid ?? 102),
        )
      } else {
        rows = []
      }
      const returnedQuery =
        options.mismatchedCaptureQuery && calls.length === 1
          ? { ...query, endAt: utcInstantFromEpochMillis(Date.parse(query.endAt) + 1) }
          : query
      const capture = makeCapture(returnedQuery, rows)
      cachedCaptures.set(queryHash, capture)
      return Effect.succeed(capture)
    },
  }
  return { client, calls }
}

const run = (
  input: VendorReplayInput,
  fixture: FixtureClient,
  now = '2026-08-20T00:00:00.000Z',
): Promise<VendorReplayReport> =>
  Effect.runPromise(
    runVendorIntradayReplay(input, fixture.client, '/tmp/bayn-vendor-replay-test', now).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  ).then((report) => {
    expectBoundedQuoteQueries(fixture)
    return report
  })

const expectBoundedQuoteQueries = (fixture: FixtureClient): void => {
  const quoteQueries = fixture.calls.filter(({ kind }) => kind === AlpacaHistoricalKind.Quotes)
  expect(
    quoteQueries.every(({ startAt, endAt }) => Date.parse(endAt) - Date.parse(startAt) <= protocol.maximumQuoteAgeMs),
  ).toBe(true)
}

const firstSession = (report: VendorReplayReport) => {
  const scenario = report.scenarios[0]
  if (scenario === undefined) throw new Error('test report has no scenario')
  const session = scenario.sessions[0]
  if (session === undefined) throw new Error('test report has no session')
  return { scenario, session }
}

describe('vendor intraday replay orchestration', () => {
  test('rejects identity mismatches before any historical capture', async () => {
    const fixture = makeFixtureClient()
    const input = inputFor()
    const exit = await Effect.runPromiseExit(
      runVendorIntradayReplay(
        { ...input, strategyProtocolHash: '0'.repeat(64) },
        fixture.client,
        '/tmp/bayn-vendor-replay-test',
        '2026-08-20T00:00:00.000Z',
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    expect(exit._tag).toBe('Failure')
    expect(fixture.calls).toHaveLength(0)
  })

  test('rejects a self-consistent capture returned for another historical query', async () => {
    const fixture = makeFixtureClient({ mismatchedCaptureQuery: true })
    const exit = await Effect.runPromiseExit(
      runVendorIntradayReplay(
        inputFor(),
        fixture.client,
        '/tmp/bayn-vendor-replay-test',
        '2026-08-20T00:00:00.000Z',
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    expect(exit._tag).toBe('Failure')
    expect(fixture.calls).toHaveLength(1)
  })

  test('keeps the planning limit causal when the arrival ask moves above it', async () => {
    const fixture = makeFixtureClient({ planningAsk: 100.01, arrivalAsk: 101 })
    const report = await run(inputFor(), fixture)
    const { session } = firstSession(report)
    const order = session.orders[0]
    expect(session.status).toBe('COMPLETE')
    expect(order).toMatchObject({
      side: 'BUY',
      status: 'canceled',
      limitPriceMicros: '100010000',
      reason: 'adverse-price-exceeds-limit',
    })
    expect(session.ledger.fills).toHaveLength(0)
  })

  test('fills, marks, closes, and carries fee-adjusted cash across sessions', async () => {
    const fixture = makeFixtureClient({ planningAsk: 101.01, arrivalAsk: 101.01, historyBid: 102 })
    const report = await run(inputFor(['2026-08-18', '2026-08-19']), fixture)
    const scenario = report.scenarios[0]
    if (scenario === undefined) throw new Error('test report has no scenario')
    const first = scenario.sessions[0]
    const second = scenario.sessions[1]
    if (first === undefined || second === undefined) throw new Error('test report has fewer than two sessions')
    expect(first.status).toBe('COMPLETE')
    expect(second.status).toBe('COMPLETE')
    expect(first.ledger.fills).toHaveLength(2)
    expect(second.ledger.fills).toHaveLength(2)
    expect(BigInt(first.ledger.executionFeesMicros)).toBeGreaterThan(0n)
    expect(second.ledger.openingCashMicros).toBe(first.ledger.cashMicros)
    expect(scenario.totals.netRealizedPnlAfterCostsMicros).toBe(
      (BigInt(second.ledger.cashMicros) - BigInt(initialCapitalMicros)).toString(),
    )
    expect(BigInt(scenario.totals.netRealizedPnlAfterCostsMicros ?? '0')).toBeGreaterThan(0n)
    expect(second.maximumObservedDrawdownMicros).not.toBeNull()
    expect(
      second.observations.some((observation) => observation.kind === 'quote' && observation.purpose === 'mark'),
    ).toBe(true)
    const entryFill = first.ledger.fills.find(({ side }) => side === 'buy')
    if (entryFill === undefined) throw new Error('completed session has no entry fill')
    expect(
      first.observations
        .filter((observation) => observation.kind === 'quote' && observation.purpose === 'mark')
        .every((observation) => Date.parse(observation.observedAt) >= Date.parse(entryFill.observedAt)),
    ).toBe(true)
  })

  test('allows a later safe entry after an earlier risk excursion while retaining cumulative breach evidence', async () => {
    const fixture = makeFixtureClient({
      firstSessionRiskExcursion: true,
      planningAsk: 101.01,
      arrivalAsk: 101.01,
      historyBid: 102,
    })
    const report = await run(inputFor(['2026-08-18', '2026-08-19']), fixture)
    const scenario = report.scenarios[0]
    if (scenario === undefined) throw new Error('test report has no scenario')
    const first = scenario.sessions[0]
    const second = scenario.sessions[1]
    if (first === undefined || second === undefined) throw new Error('test report has fewer than two sessions')

    expect(first.status).toBe('COMPLETE')
    expect(first.riskLimitBreached).toBe(true)
    expect(first.orders.some(({ side, status }) => side === 'BUY' && status === 'filled')).toBe(true)
    expect(BigInt(first.maximumObservedDrawdownMicros ?? '0')).toBeGreaterThan(BigInt(riskPolicy.maxDrawdownMicros))

    expect(second.status).toBe('COMPLETE')
    expect(second.riskLimitBreached).toBe(false)
    expect(second.orders.some(({ side, status }) => side === 'BUY' && status === 'filled')).toBe(true)
    expect(scenario.totals).toMatchObject({
      completedSessionCount: 2,
      incompleteSessionCount: 0,
      executionSessionCount: 2,
      riskLimitBreached: true,
    })
    expect(scenario.totals.netRealizedPnlAfterCostsMicros).not.toBeNull()
    expect(report.qualification).toBe('NOT_QUALIFIED')
    expect(BigInt(second.maximumObservedDrawdownMicros ?? '0')).toBeGreaterThanOrEqual(
      BigInt(first.maximumObservedDrawdownMicros ?? '0'),
    )
  })

  test('keeps missing decision bars incomplete instead of recording a no-trade session', async () => {
    const report = await run(inputFor(), makeFixtureClient({ missingBars: true }))
    const { session } = firstSession(report)
    expect(session.status).toBe('INCOMPLETE')
    expect(session.orders).toHaveLength(0)
    expect(session.ledger.positions).toHaveLength(0)
    expect(session.reason).toContain('entry evidence incomplete')
    expect(session.observations[0]).toMatchObject({
      kind: 'unavailable',
      reasonCode: 'coverage',
      symbol: 'AAPL',
      field: 'bars',
    })
  })

  test('fails closed on missing marks and retains the open position', async () => {
    const report = await run(
      inputFor(),
      makeFixtureClient({ missingHistory: true, planningAsk: 101.01, arrivalAsk: 101.01 }),
    )
    const { session } = firstSession(report)
    expect(session.status).toBe('INCOMPLETE')
    expect(session.ledger.positions).toHaveLength(1)
    expect(session.orders).toHaveLength(1)
    expect(session.orders[0]?.side).toBe('BUY')
    expect(session.reason).toContain('mark')
  })

  test('does not force a closing fill and skips later sessions after close evidence fails', async () => {
    const fixture = makeFixtureClient({ cancelCloseAtArrival: true, planningAsk: 101.01, arrivalAsk: 101.01 })
    const report = await run(inputFor(['2026-08-18', '2026-08-19']), fixture)
    const scenario = report.scenarios[0]
    if (scenario === undefined) throw new Error('test report has no scenario')
    const first = scenario.sessions[0]
    const second = scenario.sessions[1]
    if (first === undefined || second === undefined) throw new Error('test report has fewer than two sessions')
    expect(first.status).toBe('INCOMPLETE')
    expect(first.orders.some((order) => order.side === 'SELL' && order.status === 'canceled')).toBe(true)
    expect(first.ledger.positions).toHaveLength(1)
    expect(second.reason).toBe('skipped after an earlier incomplete session')
    expect(second.ledger.positions).toHaveLength(1)
  })

  test('terminalizes crossed close evidence instead of retrying a structural window failure', async () => {
    const fixture = makeFixtureClient({ crossedCloseEvidence: true, planningAsk: 101.01, arrivalAsk: 101.01 })
    const report = await run(inputFor(), fixture)
    const { session } = firstSession(report)
    const closeUnavailable = session.observations.filter(
      (observation) => observation.kind === 'unavailable' && observation.purpose === 'close',
    )
    expect(session.status).toBe('INCOMPLETE')
    expect(session.reason).toContain('quote is crossed')
    expect(closeUnavailable).toHaveLength(1)
    expect(session.orders.some((order) => order.side === 'SELL')).toBe(false)
  })

  test('defines flat equity for a valid no-signal session', async () => {
    const report = await run(inputFor(), makeFixtureClient({ decisionAaplMidpoint: 100.01 }))
    const { session } = firstSession(report)
    expect(session.status).toBe('COMPLETE')
    expect(session.ledger.fills).toHaveLength(0)
    expect(session.peakEquityMicros).toBe(initialCapitalMicros)
    expect(session.maximumObservedDrawdownMicros).toBe('0')
  })

  test('binds the canonical evaluation instant into the report identity', async () => {
    const first = await run(inputFor(), makeFixtureClient(), '2026-08-20T00:00:00.000Z')
    const second = await run(inputFor(), makeFixtureClient(), '2026-08-21T00:00:00.000Z')
    expect(first.evaluatedAt).toBe('2026-08-20T00:00:00.000Z')
    expect(second.evaluatedAt).toBe('2026-08-21T00:00:00.000Z')
    expect(first.reportHash).not.toBe(second.reportHash)
  })

  test('rejects an empty or not-yet-final calendar before historical capture', async () => {
    const emptyFixture = makeFixtureClient()
    const emptyExit = await Effect.runPromiseExit(
      runVendorIntradayReplay(
        { ...inputFor(), calendar: [] },
        emptyFixture.client,
        '/tmp/bayn-vendor-replay-test',
        '2026-08-20T00:00:00.000Z',
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    expect(emptyExit._tag).toBe('Failure')
    expect(emptyFixture.calls).toHaveLength(0)

    const futureFixture = makeFixtureClient()
    const futureExit = await Effect.runPromiseExit(
      runVendorIntradayReplay(
        inputFor(),
        futureFixture.client,
        '/tmp/bayn-vendor-replay-test',
        '2026-08-18T14:00:00.000Z',
      ).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    expect(futureExit._tag).toBe('Failure')
    expect(futureFixture.calls).toHaveLength(0)
  })
})
