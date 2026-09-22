import { expect, test } from 'bun:test'
import { NodeServices } from '@effect/platform-node'
import { gzipSync } from 'node:zlib'
import { Effect, FileSystem, Result } from 'effect'

import { OrderSide } from '../execution/contracts'
import { canonicalHashV1, sha256 } from '../hash'
import { nativeJevFixture } from '../jev/native.test-support'
import { loadQuoteBoundExecutionRiskPolicy } from '../observe-composition/decision-builder'
import { retainedReplayFixture, retainedReplayCaptureFixture } from '../testing/retained-replay-fixture'
import { config } from '../testing/runtime-fixtures'
import { jevModel } from '../jev/contract'
import { ControlPolicy } from './control-portfolio'
import { runControlSession, runControlStudy, type ControlMarket } from './control-study'

const fixture = nativeJevFixture()
const openMs = Date.parse(fixture.snapshot.manifest.calendar.sessions[0]?.openAt ?? '')
const closeMs = openMs + 90 * 60_000
const assumptions = { latencyMs: 100, slippageBps: 1, availableLiquidityPpm: 1_000_000, feeMultiplierPpm: 1_000_000 }
const simulate = async (
  options: {
    missingSnapshot?: boolean
    missingExitQuotes?: boolean
    decisionLatencyMs?: number
    emptyAssets?: boolean
    tinyExit?: boolean
    dataCostMicros?: string
    maximumLossMicros?: string
    maximumDrawdownMicros?: string
    zeroBidAtMs?: number
  } = {},
) => {
  let clock = openMs - 1
  let snapshots = 0
  const market: ControlMarket = {
    advanceTo: (atMs) =>
      Effect.sync(() => {
        expect(atMs).toBeGreaterThanOrEqual(clock)
        clock = atMs
      }),
    quoteAt: (symbol, atMs) =>
      Effect.sync(() => {
        expect(atMs).toBe(clock)
        const original = fixture.snapshot.latestQuotes[symbol]
        if (original === undefined || (options.missingExitQuotes === true && atMs > openMs + 44 * 60_000))
          return undefined
        const at = new Date(atMs).toISOString()
        const value = {
          ...original,
          eventAt: at,
          ingestedAt: at,
          bidSize: atMs === options.zeroBidAtMs ? 0 : options.tinyExit === true ? 1 : 1000,
          askSize: 1000,
        }
        return { value, sequence: 1, availableAtMs: atMs, recordHash: canonicalHashV1(value) }
      }),
    snapshot: (query) =>
      Effect.sync(() => {
        snapshots += 1
        expect(Date.parse(query.observedAt)).toBe(clock)
        if (options.missingSnapshot === true)
          return { status: 'UNAVAILABLE' as const, cause: { reason: 'fixture-missing-benchmark' } }
        const snapshot = {
          ...fixture.snapshot,
          manifest: { ...fixture.snapshot.manifest, observedAt: query.observedAt },
          latestQuotes: Object.fromEntries(
            Object.entries(fixture.snapshot.latestQuotes).map(([symbol, value]) => [
              symbol,
              { ...value, eventAt: query.observedAt, ingestedAt: query.observedAt },
            ]),
          ),
          trades: fixture.snapshot.trades.map((value) => ({
            ...value,
            eventAt: query.observedAt,
            ingestedAt: query.observedAt,
          })),
        }
        return { status: 'AVAILABLE' as const, snapshot }
      }),
  }
  const risk = await Effect.runPromise(
    loadQuoteBoundExecutionRiskPolicy('control-session-test', fixture.protocol.universe),
  )
  const report = await Effect.runPromise(
    runControlSession({
      policy: ControlPolicy.RelativeMomentum,
      protocol: fixture.protocol,
      risk: {
        ...risk,
        maxDailyLossMicros: options.maximumLossMicros ?? risk.maxDailyLossMicros,
        maxDrawdownMicros: options.maximumDrawdownMicros ?? risk.maxDrawdownMicros,
      },
      session: {
        date: fixture.snapshot.manifest.sessionDate,
        openAt: new Date(openMs).toISOString(),
        closeAt: new Date(closeMs).toISOString(),
      },
      calendar: fixture.snapshot.manifest.calendar,
      openingCashMicros: '100000000000',
      openingPeakEquityMicros: '100000000000',
      dataCostMicros: options.dataCostMicros ?? '0',
      targetWeight: 0.1,
      decisionLatencyMs: options.decisionLatencyMs ?? 1000,
      pollIntervalMs: 30_000,
      assumptions,
      eligibleSymbols: new Set(options.emptyAssets === true ? [] : fixture.protocol.candidateSymbols),
      market,
    }),
  )
  return { report, snapshots }
}

test('chronological controls reuse flat cash, respect full decision and route latency, and mark open through close', async () => {
  const { report, snapshots } = await simulate({ dataCostMicros: '1000000' })
  expect(report.completion).toBe('COMPLETE')
  expect(report.completedEpisodes).toBeGreaterThanOrEqual(3)
  expect(report.ledger.positions).toHaveLength(0)
  expect(snapshots).toBe(report.orders.filter((order) => order.side === OrderSide.Buy).length)
  for (const [index, episode] of report.episodes.entries()) {
    const prior = report.episodes[index - 1]
    if (prior !== undefined) expect(episode.enteredAtMs).toBeGreaterThan(prior.exitedAtMs)
    expect(episode.exitedAtMs).toBeLessThan(closeMs)
  }
  const firstDecision = report.decisions.find((decision) => decision.status === 'SELECTED')
  const firstOrder = report.orders[0]
  if (firstDecision === undefined || firstOrder === undefined) throw new Error('Expected first decision and order')
  expect(Date.parse(firstOrder.submittedAt) - Date.parse(firstDecision.observedAt)).toBe(1000)
  expect(Date.parse(firstOrder.arrivedAt) - Date.parse(firstOrder.submittedAt)).toBe(100)
  expect(report.marks).toHaveLength(91)
  expect(report.marks[0]?.equityMicros).toBe('99999000000')
  expect(report.marks.at(-1)?.observedAt).toBe(new Date(closeMs).toISOString())
  expect(report.marks.at(-1)?.equityMicros).toBe(report.ledger.cashMicros)
  expect(BigInt(report.netPnlAfterKnownCostsMicros ?? '0')).toBe(
    BigInt(report.ledger.netRealizedPnlAfterCostsMicros ?? '0') - 1_000_000n,
  )
  expect(report.episodes.reduce((sum, episode) => sum + BigInt(episode.netExecutionPnlMicros), 0n)).toBe(
    BigInt(report.ledger.netRealizedPnlAfterCostsMicros ?? '0'),
  )
})

test('missing observations retain zero-trade sessions as incomplete instead of inventing entries', async () => {
  const { report, snapshots } = await simulate({ missingSnapshot: true })
  expect(snapshots).toBeGreaterThan(50)
  expect(report.completion).toBe('INCOMPLETE')
  expect(report.issues).toEqual(['MISSING_DECISION_DATA'])
  expect(report.missingDecisions).toBe(snapshots)
  expect(report.orders).toHaveLength(0)
  expect(report.completedEpisodes).toBe(0)
  expect(canonicalHashV1(report)).toHaveLength(64)
})

test('missing exit prices retain the position and missing marks through close', async () => {
  const { report } = await simulate({ missingExitQuotes: true })
  expect(report.completion).toBe('INCOMPLETE')
  expect(report.issues).toContain('UNCLOSED_POSITION')
  expect(report.issues).toContain('MISSING_EXECUTION_QUOTES')
  expect(report.issues).toContain('MISSING_VALUATION')
  expect(report.completedEpisodes).toBe(0)
  expect(report.netPnlAfterKnownCostsMicros).toBeNull()
  expect(report.ledger.positions).toHaveLength(1)
})

test('a zero-size bid leaves a missing valuation even when the position later closes', async () => {
  const zeroBidAtMs = openMs + 40 * 60_000
  const { report } = await simulate({ zeroBidAtMs })
  expect(report.ledger.positions).toHaveLength(0)
  expect(report.completedEpisodes).toBeGreaterThan(0)
  expect(report.completion).toBe('INCOMPLETE')
  expect(report.issues).toContain('MISSING_VALUATION')
  expect(report.marks.find((mark) => Date.parse(mark.observedAt) === zeroBidAtMs)).toMatchObject({
    equityMicros: null,
    cause: 'no-displayed-bid-liquidity',
  })
})

test('small exit liquidity retries the same inventory and counts only completed episodes', async () => {
  const { report } = await simulate({ tinyExit: true })
  const sells = report.ledger.fills.filter((fill) => fill.side === 'sell')
  expect(sells.length).toBeGreaterThan(report.completedEpisodes)
  expect(sells.every((fill) => fill.quantityMicros === '1000000')).toBeTrue()
  expect(report.ledger.fills.filter((fill) => fill.side === 'buy').length).toBe(
    report.completedEpisodes + report.ledger.positions.length,
  )
})

test('expired decisions and ineligible assets cannot submit entries', async () => {
  const expired = (await simulate({ decisionLatencyMs: 6000 })).report
  expect(expired.orders).toHaveLength(0)
  expect(expired.decisions.some((decision) => decision.status === 'DECISION_EXPIRED')).toBeTrue()
  const ineligible = (await simulate({ emptyAssets: true })).report
  expect(ineligible.orders).toHaveLength(0)
  expect(ineligible.decisions.some((decision) => decision.status === 'RISK_OR_CAPITAL_BLOCKED')).toBeTrue()
})

test.each(['maximumLossMicros', 'maximumDrawdownMicros'] as const)(
  'entries at the native %s boundary are allowed, and a one-micro excess is blocked',
  async (limit) => {
    const atBoundary = (await simulate({ dataCostMicros: '1000000', [limit]: '1000000' })).report
    expect(atBoundary.orders.some((order) => order.side === OrderSide.Buy)).toBeTrue()
    const exceeded = (await simulate({ dataCostMicros: '1000000', [limit]: '999999' })).report
    expect(exceeded.orders).toHaveLength(0)
  },
)

test('full frozen-source control runner produces reproducible hashed incomplete zero-trade sessions', async () => {
  const retained = retainedReplayFixture()
  const source = {
    ...retained.manifest,
    coverageStartMs: Date.parse('2026-09-04T13:30:00Z'),
    coverageEndMs: Date.parse('2026-09-04T20:00:00Z'),
  }
  const { verification: _verification, ...build } = config.build
  const input = {
    schemaVersion: 'bayn.control-study-input.v1',
    decisionLatencyMs: 1000,
    repeatedTargetWeightPpm: 100000,
    backtest: {
      schemaVersion: 'bayn.backtest.v3',
      inference: {
        mode: 'measured-provider',
        model: jevModel,
        inputDefinition: 'bayn.jev-trading-signal-state.v2',
        costs: { inputMicrosPerMillionTokens: '42000', outputMicrosPerMillionTokens: '0' },
      },
      allocatedDataCostPerSessionMicros: '1000000',
      replicate: 'control-source-fixture',
      sessionDates: ['2026-09-04'],
      source,
      openingCashMicros: '100000000000',
      fractionalTrading: false,
      calendar: [...retained.input.input.calendar, { date: '2026-09-08', open: '09:30', close: '16:00' }],
      assets: retained.input.protocol.universe.map((symbol, index) => ({
        id: `12345678-1234-4234-8234-${String(index).padStart(12, '0')}`,
        symbol,
        class: 'us_equity',
        exchange: 'NASDAQ',
        status: 'active',
        tradable: true,
        fractionable: true,
      })),
      assetObservationAt: '2026-09-04T13:29:00.000Z',
      assetObservationPolicy: 'retained-as-of-session',
      build,
      assumptions,
      cadence: {
        pollIntervalMs: 30000,
        reconciliationIntervalMs: 30000,
        reconciliationPassTimeoutMs: 30000,
        reconciliationStaleThresholdMs: 120000,
      },
    },
  }
  const receipt = retainedReplayCaptureFixture(source)
  await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped()
      const arrivals = `${directory}/arrivals.ndjson.gz`
      yield* fs.writeFile(arrivals, gzipSync(retained.body))
      const report = yield* runControlStudy(input, arrivals, receipt)
      expect(report.sessions).toHaveLength(3)
      for (const session of report.sessions) {
        expect(session.completion).toBe('INCOMPLETE')
        expect(session.completedEpisodes).toBe(0)
        expect(session.netPnlAfterKnownCostsMicros).toBe('-1000000')
        expect(session.marks).toHaveLength(391)
        expect(session.missingDecisions).toBeGreaterThan(0)
      }
      const { reportHash, ...material } = report
      expect(canonicalHashV1(material)).toBe(reportHash)
      const inputText = JSON.stringify(input)
      const receiptText = JSON.stringify({
        schemaVersion: 'bayn.replay-source-capture.v1',
        capturedAt: new Date(source.coverageEndMs + 1).toISOString(),
        origin: 'Independently frozen deterministic capture fixture',
        coverageStartMs: source.coverageStartMs,
        coverageEndMs: source.coverageEndMs,
        universe: source.universe,
        positions: source.positions,
      })
      yield* fs.writeFileString(`${directory}/input.json`, inputText)
      yield* fs.writeFileString(`${directory}/receipt.json`, receiptText)
      const args = [
        'bun',
        new URL('../../tools/control-study.ts', import.meta.url).pathname,
        '--input',
        `${directory}/input.json`,
        '--input-sha256',
        sha256(inputText),
        '--arrivals',
        arrivals,
        '--source-receipt',
        `${directory}/receipt.json`,
        '--source-receipt-sha256',
        sha256(receiptText),
        '--output',
        `${directory}/report.json`,
      ]
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' })),
        (process) =>
          Effect.sync(() => {
            process.kill()
          }),
      )
      const status = yield* Effect.promise(() => child.exited)
      const error = yield* Effect.promise(() => new Response(child.stderr).text())
      expect({ status, error }).toEqual({ status: 0, error: '' })
      const written = yield* fs.readFileString(`${directory}/report.json`)
      expect(written).toBe(`${JSON.stringify(report, null, 2)}\n`)
      yield* fs.writeFile(arrivals, gzipSync(`${retained.body} `))
      const corrupt = yield* Effect.result(runControlStudy(input, arrivals, receipt))
      expect(Result.isFailure(corrupt)).toBeTrue()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )
}, 30_000)
