import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeFileSystem } from '@effect/platform-node'
import { ConfigProvider, Effect, Layer, Redacted, Result } from 'effect'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { canonicalHashV1Result } from '../src/hash'
import { sipUniverse } from '../src/market-data/sip/universe'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { Profile, universe } from '../src/strategy/macro-etf-core/policy'
import { runScorecard } from './bayn-daily-scorecard'
import { analyzeProfitability, decodeAuditInput } from './live-profitability-audit-core'
import type { Position } from './macro-canary-runner/alpaca'
import { Mode, TimeInForce } from './macro-canary-runner/contract'
import { etfs, historyLength, wave5dRevision } from './macro-canary-runner/signals'
import { RunnerProfile } from './macro-etf-core-runner/contract'
import { buildScorecard, Gate, renderScorecardJson, renderScorecardMarkdown } from './multi-horizon-scorecard-core'

const digest = 'a'.repeat(64)
const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const at = (date: string, time: string) => `${date}T${time}Z`
const days = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 0, i + 2)))
  .filter((row) => row.getUTCDay() > 0 && row.getUTCDay() < 6)
  .map((row) => row.toISOString().slice(0, 10))
const calendar = days.map((date) => ({
  date,
  openAt: at(date, '14:30:00.000000000'),
  closeAt: at(date, '21:00:00.000'),
}))
const report = ({ date, openAt, closeAt }: (typeof calendar)[number], pnl = '2000000') => {
  const input = Result.getOrThrow(
    decodeAuditInput({
      schemaVersion: 'bayn.live-profitability-evidence.v1',
      sessions: [
        {
          date,
          asOf: at(date, '22:05:00.000'),
          dayStartAt: at(date, '05:00:00.000'),
          calendar: { openAt: openAt.replace(/\.0+Z$/, '.000Z'), closeAt },
          openingEquityMicros: '100000000000',
          openingPositions: [],
          positionMarks: [],
          entries: [
            {
              id: 'entry',
              sleeve: IntradayAlphaPhase.NoiseAreaTrend,
              symbol: 'QQQ',
              side: OrderSide.Buy,
              quantityAtoms: '1000000000',
              signalMicros: '100000000',
              referenceMicros: '100000000',
              holdMinutes: 120,
            },
          ],
          orders: [
            {
              id: 'enter',
              entryId: 'entry',
              side: OrderSide.Buy,
              openedAt: at(date, '15:00:00.000000001'),
              terminalAt: at(date, '15:00:00.000000003'),
            },
            {
              id: 'exit',
              entryId: null,
              side: OrderSide.Sell,
              openedAt: at(date, '15:40:00.000000001'),
              terminalAt: at(date, '15:40:00.000000003'),
            },
          ].map((order) => ({
            ...order,
            parentId: null,
            symbol: 'QQQ',
            type: OrderType.Limit,
            status: OrderStatus.Filled,
            quantityAtoms: '1000000000',
            limitMicros: order.side === OrderSide.Buy ? '100010000' : '100000000',
            exitReferenceMicros: order.side === OrderSide.Buy ? null : '100000000',
            stopMicros: null,
            protective: false,
          })),
          fills: [
            {
              id: 'a',
              orderId: 'enter',
              side: OrderSide.Buy,
              at: at(date, '15:00:00.000000002'),
              priceAtoms: '100010000000',
              realizedMicros: '0',
            },
            {
              id: 'b',
              orderId: 'exit',
              side: OrderSide.Sell,
              at: at(date, '15:40:00.000000002'),
              priceAtoms: '100000000000',
              realizedMicros: pnl,
            },
          ].map((fill) => ({ ...fill, symbol: 'QQQ', quantityAtoms: '1000000000', feeMicros: '0' })),
          reconciliation: {
            at: at(date, '22:01:00.000'),
            positionsAt: at(date, '22:00:00.000'),
            exact: true,
            coversActivity: true,
            positionCount: 0,
            positions: [],
          },
          controller: [
            {
              id: 'pass',
              at: at(date, '21:01:00.000'),
              noAdmissibleCut: false,
              closeMarketDataUnavailable: false,
              closeWindowExpired: false,
            },
          ],
          market: { bars: [], quotes: [] },
          postedFeeDebitMicros: '0',
          pendingFees: 0,
          missingFillEvents: 0,
          unverifiedDecisions: 0,
        },
      ],
    }),
  )
  return analyzeProfitability(input)
}

const coreAccount = '11111111-1234-4234-8123-000000000001'
const canaryAccount = '11111111-1234-4234-8123-000000000002'
const common = (date: string, prior: string, accountId: string, positions: Position[] = []) => ({
  broker: 'alpaca-paper',
  signalSession: prior,
  signalCloseAt: at(prior, '21:00:00.000'),
  executionSession: date,
  executionOpenAt: at(date, '14:30:00.000000000'),
  tif: TimeInForce.Open,
  barSha256: digest,
  rawSizingBars: { feed: 'sip', timeframe: '1Day', adjustment: 'raw', rows: [] },
  reconciliation: {
    account: {
      id: accountId,
      status: 'ACTIVE',
      currency: 'USD',
      equity: '200000',
      cash: '200000',
      buying_power: '200000',
      account_blocked: false,
      trading_blocked: false,
      trade_suspended_by_user: false,
    },
    openOrders: [],
    positions,
  },
})
const basePlan = () => ({
  blocked: null,
  rebalanceDue: false,
  budgetCents: 15_000_000,
  cashCents: 20_000_000,
  buyingPowerCents: 20_000_000,
  equityCents: 20_000_000,
  managedGrossCents: 0,
  overnightCapCents: 15_000_000,
  intradayCapCents: 18_000_000,
  maximumProjectedGrossCents: 0,
  remainingIntradayGrossCents: 18_000_000,
  buyLimitNotionalCents: 0,
  orders: [],
})
const excluded = ['QQQ', 'SMH']
const signalBars = { feed: 'sip', timeframe: '1Day', adjustment: 'all' }
const dollars = (value: number) => BigInt(value) * 1_000_000n
const signed = <A extends { executionSession: string }>(receipt: A) => ({
  ...receipt,
  planSha256: hash(receipt),
  mode: Mode.Shadow,
  timestamp: at(receipt.executionSession, '13:00:00.123456789'),
})
const resign = <A extends ReturnType<typeof signed>>(receipt: A) => {
  const { planSha256: _digest, mode, timestamp, ...material } = receipt
  return { ...receipt, planSha256: hash(material), mode, timestamp }
}
const coreReceipt = (date: string, prior: string, profile: typeof RunnerProfile.F2 | typeof RunnerProfile.F4) =>
  signed({
    ...common(date, prior, coreAccount),
    schemaVersion: 'bayn.macro-etf-core-rebalance-receipt.v1',
    profile,
    configuredExclusions: excluded,
    configuredBudgetCents: 15_000_000,
    signalBars: { ...signalBars, sessions: 268, snapshotSha256: digest, missingCandidates: [] },
    allocation: {
      components: [
        {
          profile: profile === RunnerProfile.F2 ? Profile.F2 : Profile.F4,
          policyHash: digest,
          signal: {
            policyHash: digest,
            signalDate: prior,
            signalCloseAt: Date.parse(at(prior, '21:00:00')),
            executionDate: date,
            executionOpenAt: Date.parse(at(date, '14:30:00')),
            weights: universe.map((symbol) => Number(symbol === 'SHY')),
          },
        },
      ],
      excludedSymbols: excluded,
      targets: universe.map((symbol) => ({ symbol, weight: Number(symbol === 'SHY') })),
    },
    plan: {
      ...basePlan(),
      managedGrossCents: 10_000_000,
      maximumProjectedGrossCents: 10_000_000,
      reservedGrossCents: 0,
      reviewDue: true,
      collarBps: 15,
      deadbandBps: 1000,
    },
  })
const canaryReceipt = (date: string, prior: string) =>
  signed({
    ...common(date, prior, canaryAccount),
    schemaVersion: 'bayn.macro-canary-rebalance-receipt.v1',
    strategyRevision: wave5dRevision,
    signalBars: { ...signalBars, sessions: historyLength, firstSession: '2024-10-10', macroSeedSessions: 1_000 },
    signals: {
      reviewedAt: prior,
      reviewDue: false,
      canaries: [],
      canaryProtection: 0,
      tsmomScores: etfs.map((symbol) => ({ symbol, value: 0 })),
      macro: {
        quadrant: 'Stagflation',
        credit: 0,
        inflation: 0,
        dollar: 0,
        unsmoothedWeights: etfs.map((symbol) => ({ symbol, value: Number(symbol === 'SHY') })),
      },
      sleeves: [],
      idleShyWeight: 0,
      // Strategic O1 targets are pre-exclusion; actionable plan sizing must zero QQQ.
      targetWeights: etfs.map((symbol) => ({ symbol, weight: Number(symbol === 'QQQ') })),
    },
    plan: {
      ...basePlan(),
      excludedSymbols: excluded,
      excludedTargetWeight: 1,
      driftBand: 0.1,
      collarBp: 15,
      sizing: etfs.map((symbol) => ({
        symbol,
        managed: symbol !== 'QQQ',
        referenceMicros: 100000000,
        currentWeight: 0,
        targetWeight: 0,
        outsideBand: false,
      })),
      managedGrossCents: 5_000_000,
      maximumProjectedGrossCents: 5_000_000,
      otherGrossCents: 0,
      usedBuyScale: 1,
      sellLimitNotionalCents: 0,
      referenceNotionalMicros: 0,
      expectedTurnover: 0,
      expectedSleeveTurnover: 0,
    },
  })
const campaign = (count = 20, profile: typeof RunnerProfile.F2 | typeof RunnerProfile.F4 = RunnerProfile.F4) => {
  const selected = calendar.slice(0, count)
  const intraday = selected.map((session) => report(session))
  const prior = (i: number) => days[i - 1] ?? '2025-12-31'
  return {
    intraday,
    macroCore: selected.map(({ date }, i) => coreReceipt(date, prior(i), profile)),
    macroCanary: selected.map(({ date }, i) => canaryReceipt(date, prior(i))),
    qualification: {
      schemaVersion: 'bayn.multi-horizon-qualification-evidence.v1',
      policy: 'bayn.intraday-alpha-policy.v3',
      paperAccountSha256: digest,
      protocolSha256: digest,
      calendarSourceSha256: digest,
      riskCostPolicySha256: digest,
      calendar: selected,
      proofs: intraday.flatMap(({ sessions }) =>
        sessions.map((audit) => ({
          date: audit.date,
          auditSessionSha256: hash(audit),
          sourceSha256: digest,
          intradayPeakGrossMicros: dollars(30_000).toString(),
          riskCostMicros: '500000',
          stopEvidenceComplete: true,
        })),
      ),
    },
  }
}
type Bundle = ReturnType<typeof campaign>
const score = (input: unknown) => {
  const result = buildScorecard(input)
  if (Result.isFailure(result)) throw Redacted.value(result.failure.cause)
  return result.success
}
const changeAudit = (
  bundle: Bundle,
  i: number,
  update: (audit: Bundle['intraday'][number]['sessions'][number]) => void,
) => {
  const audit = bundle.intraday[i].sessions[0]
  update(audit)
  bundle.qualification.proofs[i].auditSessionSha256 = hash(audit)
}
const setSlip = (bundle: Bundle, i: number, roundTripBps: number[]) =>
  changeAudit(bundle, i, (audit) => {
    audit.slippageGate.roundTripBps = roundTripBps
    audit.slippageGate.samples = roundTripBps.length
    audit.metrics.roundTrip.samples = roundTripBps.length
  })

test('20 clean F2/F4 PAPER sessions pass exactly at $150k/$180k gross and 2.5 bp median', () => {
  for (const profile of [RunnerProfile.F2, RunnerProfile.F4] as const) {
    const data = campaign(20, profile)
    expect(data.intraday[0].sessions[0].slippageGate.roundTripBps).toEqual([1])
    data.intraday.forEach((_, i) => setSlip(data, i, [2.5]))
    const result = score(data)
    expect(result.QUALIFICATION_GATE).toBe(Gate.Pass)
    expect(result.cleanPaperSessions).toBe(20)
    expect(result.blockingReasons).toEqual([])
    expect(result.intraday).toMatchObject({
      cumulativeNetMicros: '40000000',
      rolling20NetMicros: '40000000',
      cumulativeRiskAdjustedNetMicros: '30000000',
      slippage: { samples: 20, medianBps: 2.5, meanBps: 2.5, promotionBps: 2.5, breakevenBps: 11.2 },
      gapThroughCount: 0,
      noAdmissibleCutCount: 0,
      eodStrandedCount: 0,
    })
    expect(result.sessions[0]).toMatchObject({
      overnightGrossMicros: dollars(150_000).toString(),
      combinedGrossMicros: dollars(180_000).toString(),
      macroCore: { profile },
      sip: { gate: Gate.Incomplete },
    })
    expect(renderScorecardMarkdown(result)).toContain('QUALIFICATION_GATE: PASS')
  }
})

test('reports true pooled median rather than the mean or a median of daily medians, and a rolling 20-session net', () => {
  const data = campaign(21)
  changeAudit(data, 0, (audit) => {
    audit.metrics.netRealizedMicros = '-3000000'
    audit.metrics.realizedMicros = '-3000000'
  })
  for (let i = 0; i < 20; i++) setSlip(data, i, [5])
  setSlip(
    data,
    20,
    Array.from({ length: 21 }, () => 0),
  )
  const result = score(data)
  expect(result.intraday.slippage).toMatchObject({ samples: 41, medianBps: 0 })
  expect(result.intraday.slippage.meanBps).toBeCloseTo(100 / 41)
  expect(result.intraday.cumulativeNetMicros).toBe('37000000')
  expect(result.intraday.rolling20NetMicros).toBe('40000000')
  expect(result.QUALIFICATION_GATE).toBe(Gate.Pass)
  const reordered = {
    ...data,
    intraday: data.intraday.toReversed(),
    macroCore: data.macroCore.toReversed(),
    macroCanary: data.macroCanary.toReversed(),
  }
  expect(Result.getOrThrow(renderScorecardJson(score(reordered)))).toBe(Result.getOrThrow(renderScorecardJson(result)))
})

test('missing calendar days, proof, receipts and raw samples cannot silently qualify', () => {
  const data = campaign()
  data.macroCanary.pop()
  data.intraday.shift()
  data.qualification.proofs.splice(2, 1)
  changeAudit(data, 2, (audit) => Reflect.deleteProperty(audit.slippageGate, 'roundTripBps'))
  const result = score(data)
  expect(result.QUALIFICATION_GATE).toBe(Gate.Incomplete)
  expect(result.blockingReasons.join('\n')).toContain('Missing Macro canary receipt')
  expect(result.blockingReasons.join('\n')).toContain('Missing intraday audit')
  expect(result.blockingReasons.join('\n')).toContain('PAPER v3 scope, peak gross and risk/cost proof is missing')
  expect(result.blockingReasons.join('\n')).toContain('individual B0 round-trip slippage samples are unavailable')
  expect(result.intraday.cumulativeNetMicros).toBeNull()
  expect(result.intraday.rolling20NetMicros).toBeNull()
  expect(score(campaign(19)).QUALIFICATION_GATE).toBe(Gate.Incomplete)
  const { qualification: _qualification, ...diagnostic } = data
  expect(score(diagnostic).QUALIFICATION_GATE).toBe(Gate.Incomplete)
})

test('flags actionable overlaps, observed anomalies and both gross cap violations even with other gaps', () => {
  const data = campaign(1)
  const core = data.macroCore[0]
  core.allocation.targets[universe.indexOf('SMH')].weight = 0.01
  core.plan.maximumProjectedGrossCents++
  data.macroCore[0] = resign(core)
  const canary = data.macroCanary[0]
  canary.plan.sizing[etfs.indexOf('QQQ')].targetWeight = 0.1
  data.macroCanary[0] = resign(canary)
  changeAudit(data, 0, (audit) => {
    audit.metrics.gapThroughIncidents = 1
    audit.metrics.nonFlatEodPositions = 1
    audit.controller.noAdmissibleCut = 2
  })
  const result = score(data)
  expect(result.QUALIFICATION_GATE).toBe(Gate.Fail)
  expect(result.intraday).toMatchObject({ gapThroughCount: 1, noAdmissibleCutCount: 2, eodStrandedCount: 1 })
  expect(result.blockingReasons.join('\n')).toContain('SMH has positive effective target weight')
  expect(result.blockingReasons.join('\n')).toContain('QQQ has positive effective target weight')
  expect(result.blockingReasons.join('\n')).toContain('Combined overnight gross exceeds $150,000')
  expect(result.blockingReasons.join('\n')).toContain('Overnight plus intraday peak gross exceeds $180,000')
  expect(result.blockingReasons.join('\n')).toContain('STOP_LIMIT_GAP_THROUGH')
  expect(result.blockingReasons.join('\n')).toContain('NO_ADMISSIBLE_CUT')
  expect(result.blockingReasons.join('\n')).toContain('NON_FLAT_EOD')
})

test('daily diagnostics report isolated next-open shadow plans without qualifying or losing today’s audit', () => {
  const { intraday, macroCore, macroCanary, qualification } = campaign(2)
  const date = calendar[0].date
  const next = calendar[1].date
  const scope = { date, intradayAccountId: '00000000-0000-4000-8000-000000000000' }
  const core = macroCore[1]
  for (const target of core.allocation.targets) target.weight = Number(target.symbol === 'QQQ')
  const isolated = {
    intraday: [intraday[0]],
    macroCore: [resign({ ...core, timestamp: at(date, '22:00:00') })],
    macroCanary: [{ ...macroCanary[1], timestamp: at(date, '22:00:00') }],
  }
  const result = Result.getOrThrow(buildScorecard(isolated, scope))
  expect(result.QUALIFICATION_GATE).toBe(Gate.Incomplete)
  expect(result.blockingReasons.join('\n')).toContain('not shared-account qualification evidence')
  expect(result.blockingReasons.join('\n')).not.toContain('overlaps intraday v3')
  expect(result.sessions.find((row) => row.date === next)?.macroCore?.mode).toBe(Mode.Shadow)
  const stale = Result.getOrThrow(
    buildScorecard({ ...isolated, macroCore: [{ ...macroCore[0], timestamp: at('2025-12-31', '22:00:00') }] }, scope),
  )
  expect(stale.blockingReasons.join('\n')).toContain('Missing fresh macro ETF core receipt')
  expect(result.intraday.cumulativeNetMicros).toBe(intraday[0].sessions[0].metrics.netRealizedMicros)
  expect(score(isolated).QUALIFICATION_GATE).toBe(Gate.Fail)
  expect(Result.isFailure(buildScorecard(isolated, { ...scope, intradayAccountId: coreAccount }))).toBe(true)
  expect(Result.isFailure(buildScorecard({ ...isolated, qualification }, scope))).toBe(true)
  expect(
    Result.isFailure(
      buildScorecard({ ...isolated, macroCore: [{ ...isolated.macroCore[0], mode: Mode.PaperSubmit }] }, scope),
    ),
  ).toBe(true)
})

test('shared inventory is counted once without netting independent plans', () => {
  const data = campaign(1)
  const canary = data.macroCanary[0]
  canary.reconciliation.account.id = coreAccount
  canary.plan.maximumProjectedGrossCents = 5_250_000
  data.macroCanary[0] = resign(canary)
  data.macroCore[0].plan.maximumProjectedGrossCents = 10_100_000
  data.macroCore[0] = resign(data.macroCore[0])
  expect(score(data).sessions[0].overnightGrossMicros).toBe(dollars(103_500).toString())
  data.macroCanary[0] = resign({
    ...canary,
    reconciliation: {
      ...canary.reconciliation,
      positions: [{ symbol: 'SHY', side: 'long' as const, qty: '1', market_value: '100' }],
    },
  })
  expect(score(data).blockingReasons.join('\n')).toContain('disagree on shared account inventory')
})

test('a recomputed plan hash cannot hide broker gross', () => {
  const data = campaign(1)
  const canary = data.macroCanary[0]
  canary.reconciliation.positions.push({ symbol: 'SHY', side: 'long', qty: '600', market_value: '60000' })
  data.macroCanary[0] = resign(canary)
  const result = score(data)
  expect(result.QUALIFICATION_GATE).toBe(Gate.Fail)
  expect(result.sessions[0].overnightGrossMicros).toBe(dollars(160_000).toString())
  expect(result.blockingReasons.join('\n')).toContain('inventory gross does not cover the broker reconciliation')
  expect(result.blockingReasons.join('\n')).toContain('Combined overnight gross exceeds $150,000')
})

test('fails on a fractional excess above the slippage gate or zero cumulative risk-adjusted net', () => {
  const data = campaign()
  data.intraday.forEach((_, i) => setSlip(data, i, [2.50000001]))
  expect(score(data).blockingReasons.join('\n')).toContain('Pooled B0 median 2.50000001 bp exceeds 2.5 bp')
  data.intraday.forEach((_, i) => setSlip(data, i, [2]))
  data.qualification.proofs.forEach((proof) => {
    proof.riskCostMicros = '2000000'
  })
  expect(score(data).QUALIFICATION_GATE).toBe(Gate.Fail)
  expect(score(data).blockingReasons).toContain('Cumulative risk-adjusted net is not positive')
})

test('rejects duplicates, macro tampering and intraday proof digest mismatches', () => {
  const data = campaign(1)
  expect(Result.isFailure(buildScorecard({ ...data, intraday: [...data.intraday, ...data.intraday] }))).toBe(true)
  expect(Result.isFailure(buildScorecard({ ...data, macroCore: [...data.macroCore, ...data.macroCore] }))).toBe(true)
  expect(Result.isFailure(buildScorecard({ ...data, macroCanary: [...data.macroCanary, ...data.macroCanary] }))).toBe(
    true,
  )
  data.macroCore[0].plan.maximumProjectedGrossCents++
  const tampered = buildScorecard(data)
  expect(Result.isFailure(tampered) && Redacted.value(tampered.failure.cause)).toMatchObject({
    _tag: 'DigestMismatch',
    field: 'planSha256',
  })
  data.macroCore[0] = resign(data.macroCore[0])
  data.intraday[0].sessions[0].metrics.realizedMicros = '999'
  const mismatch = buildScorecard(data)
  expect(Result.isFailure(mismatch) && Redacted.value(mismatch.failure.cause)).toMatchObject({
    _tag: 'DigestMismatch',
    field: 'auditSessionSha256',
  })
})

test('retains schema issues while redacting supplied receipt values', () => {
  const data = campaign(1)
  const invalid = buildScorecard({
    ...data,
    macroCore: [{ ...data.macroCore[0], timestamp: 'secret-never-print' }],
  })
  if (Result.isSuccess(invalid)) throw new Error('expected schema error')
  expect(Redacted.value(invalid.failure.cause)).toHaveProperty('issue')
  expect(String(invalid.failure)).not.toContain('secret-never-print')
  expect(JSON.stringify(invalid.failure)).not.toContain('secret-never-print')
})

test('uses execution date, preserves nanosecond differences and never substitutes a signal-date receipt', () => {
  const data = campaign(1)
  data.macroCore[0] = resign({ ...data.macroCore[0], executionOpenAt: at(days[0], '14:30:00.000000001') })
  const wrongOpen = score(data)
  expect(wrongOpen.QUALIFICATION_GATE).toBe(Gate.Fail)
  expect(wrongOpen.blockingReasons.join('\n')).toContain('signal/next-open calendar mismatch')
  data.macroCore[0] = coreReceipt(days[1], days[0], RunnerProfile.F2)
  const tomorrow = score(data)
  expect(tomorrow.sessions[0].macroCore).toBeNull()
  expect(tomorrow.sessions[1].macroCore?.profile).toBe(RunnerProfile.F2)
})

test('keeps the verifier SIP shadow gate separate, including failed checks, missing receipts and duplicate rejection', () => {
  const data = campaign()
  const number = { count: 5, median: 1, p75: 1, p95: 2 }
  const feed = {
    expectedBars: 390,
    barCount: 390,
    barCoverage: 1,
    quoteCount: 100,
    spreadBps: number,
    crossedQuotes: 0,
    lockedQuotes: 0,
    oneSidedQuotes: 0,
    staleQuotes: 0,
    staleQuoteRate: 0,
    barIngestLatencyMs: number,
    quoteIngestLatencyMs: number,
  }
  const checks = [
    'sip-universe',
    ...['QQQ', 'SMH', 'XLK', ...sipUniverse.benchmarks].map((symbol) => `sip-bar-coverage:${symbol}`),
    'sip-crossed-quotes',
    'sip-quote-ingest-latency',
    ...['QQQ', 'SMH', 'XLK'].map((symbol) => `sip-median-spread:${symbol}`),
  ].map((id) => ({ id, pass: true, criterion: id, actual: 1 }))
  const receipt = {
    schemaVersion: 'bayn.sip-shadow-parity-report.v1',
    session: calendar[0],
    expectedMinutes: 390,
    universe: {
      id: sipUniverse.id,
      expectedHash: sipUniverse.symbolHash,
      observedHash: sipUniverse.symbolHash,
      observedCount: sipUniverse.all73.length,
      missing: [],
      unexpected: [],
      mismatchedSipRows: 0,
    },
    gate: { pass: true, checks },
    pooled: { iex: feed, sip: feed, barCloseDivergenceBps: number },
    commonSymbolSpreads: { symbols: ['QQQ', 'SMH'], iex: number, sip: number, medianSpreadCompressionBps: 0.5 },
    bySymbol: ['QQQ', 'SMH', 'XLK', ...sipUniverse.benchmarks].map((symbol) => ({
      symbol,
      iex: feed,
      sip: feed,
      barCloseDivergenceBps: number,
      medianSpreadCompressionBps: 0.5,
    })),
  }
  expect(score({ ...data, sip: [receipt] }).sessions[0].sip).toMatchObject({ gate: Gate.Pass, observedSymbols: 73 })
  expect(Result.isFailure(buildScorecard({ ...data, sip: [receipt, receipt] }))).toBe(true)
  checks[0].pass = false
  receipt.gate.pass = false
  const failedReceipt = { ...receipt, universe: { ...receipt.universe, observedHash: digest } }
  const rejected = score({ ...data, sip: [failedReceipt] })
  expect(rejected.sessions[0].sip).toMatchObject({ gate: Gate.Fail, blockingChecks: ['sip-universe'] })
  expect(rejected.sessions[1].sip.gate).toBe(Gate.Incomplete)
  expect(rejected.QUALIFICATION_GATE).toBe(Gate.Pass)
})

test('CLI reads local receipt directories, writes private exclusive output and retains redacted JSON errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bayn-scorecard-test-'))
  try {
    const bundle = campaign()
    const intraday = join(root, 'intraday')
    const macroCore = join(root, 'macro-core')
    const macroCanary = join(root, 'macro-canary')
    const qualification = join(root, 'qualification.json')
    const output = join(root, 'scorecard.json')
    await Promise.all([intraday, macroCore, macroCanary].map((directory) => mkdir(directory)))
    await Promise.all([
      writeFile(
        join(intraday, 'sessions.json'),
        JSON.stringify([{ ...bundle.intraday[0], sessions: bundle.intraday.flatMap((row) => row.sessions) }]),
      ),
      writeFile(join(macroCore, 'sessions.json'), JSON.stringify(bundle.macroCore)),
      writeFile(join(macroCanary, 'sessions.json'), JSON.stringify(bundle.macroCanary)),
      writeFile(join(macroCanary, 'pending.jsonl'), 'invalid journal, not a receipt'),
      writeFile(qualification, JSON.stringify(bundle.qualification)),
    ])
    const args = [
      '--intraday-dir',
      intraday,
      '--macro-core-dir',
      macroCore,
      '--macro-canary-dir',
      macroCanary,
      '--qualification-file',
      qualification,
      '--output',
      output,
    ]
    const run = (argv: string[]) =>
      Effect.runPromise(
        runScorecard(argv).pipe(
          // @effect-diagnostics-next-line strictEffectProvide:off -- test runtime boundary
          Effect.provide(
            Layer.merge(
              NodeFileSystem.layer,
              ConfigProvider.layer(ConfigProvider.fromEnv({ env: { BAYN_SCORECARD_FORMAT: 'json' } })),
            ),
          ),
          Effect.result,
        ),
      )
    expect(Result.isSuccess(await run(args))).toBe(true)
    const text = await readFile(output, 'utf8')
    expect(JSON.parse(text)).toMatchObject({
      schemaVersion: 'bayn.multi-horizon-scorecard.v1',
      QUALIFICATION_GATE: Gate.Pass,
    })
    expect((await stat(output)).mode & 0o777).toBe(0o600)
    expect(Result.isFailure(await run(args))).toBe(true)
    expect(await readFile(output, 'utf8')).toBe(text)
    await writeFile(join(intraday, 'bad.json'), 'bad-private-payload')
    const invalid = await run([...args.slice(0, -1), join(root, 'unused.json')])
    if (Result.isSuccess(invalid)) throw new Error('expected malformed JSON failure')
    expect(Redacted.value(invalid.failure.cause)).toHaveProperty('issue')
    expect(String(invalid.failure)).not.toContain('bad-private-payload')
    expect(await Bun.file(join(root, 'unused.json')).exists()).toBe(false)
    const cli = fileURLToPath(new URL('./bayn-daily-scorecard.ts', import.meta.url))
    const child = Bun.spawn([process.execPath, cli, ...args.slice(0, -2), '--format', 'json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('Cannot read or parse JSON: intraday audit JSON file #1')
    expect(stderr).not.toContain('bad-private-payload')
  } finally {
    await rm(root, { force: true, recursive: true })
  }
})
