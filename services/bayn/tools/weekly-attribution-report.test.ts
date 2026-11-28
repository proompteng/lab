import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Redacted, Result } from 'effect'

import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { canonicalHashV1Result } from '../src/hash'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { macroCanaryEtfs } from '../src/strategy/macro-canary-etf/policy'
import type { MacroCanaryEtfTarget } from '../src/strategy/macro-canary-etf/signals'
import { Profile, universe } from '../src/strategy/macro-etf-core/policy'
import { runWeeklyAttribution } from './bayn-weekly-attribution-report'
import { analyzeProfitability, AuditInput } from './live-profitability-audit-core'
import { Side } from './macro-canary-runner/alpaca'
import { TimeInForce } from './macro-canary-runner/contract'
import { orderPrefix } from './macro-canary-runner/planner'
import { RunnerProfile } from './macro-etf-core-runner/contract'
import {
  CanaryProfile,
  decodeManifest,
  makePortfolioReceipt,
  SleeveMode,
  Strategy,
} from './multi-account-daily-sleeves/contract'
import { buildScorecard, Gate } from './multi-horizon-scorecard-core'
import { CoreReceipt } from './multi-horizon-scorecard-receipts'
import { HoldReason, RotationPhase, type CanaryPlanReceipt, type CorePlanReceipt } from './weekly-attribution-receipts'
import {
  AttributionStatus,
  buildWeeklyAttributionReport,
  buildWeeklyKnowledgeDelta,
  renderWeeklyAttributionJson,
  renderWeeklyAttributionMarkdown,
  RotationStatus,
} from './weekly-attribution-report'

const intradayId = '11111111-1234-4234-8123-000000000001'
const coreId = '22222222-1234-4234-8123-000000000002'
const canaryId = '33333333-1234-4234-8123-000000000003'
const sha = 'a'.repeat(64)
const commit = 'c'.repeat(40)
const secret = 'sk-proj-SYNTHETIC_private_key_123456'
const email = 'operator@example.test'
const dates = ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11'] as const
const signalDates = ['2026-12-04', ...dates] as const
const at = (date: string, time: string) => `${date}T${time}:00.000Z`
const usdMicros = (usd: number) => String(Math.round(usd * 1_000_000))
const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const sip = CoreReceipt.fields.signalBars.fields.feed.literal

type Session = typeof AuditInput.fields.sessions.value.Type
const auditSession = (date: Session['date'], netUsd: number, slipBps: number): Session => {
  const entryPriceAtoms = 100_000_000_000 + Math.round(slipBps * 10_000_000)
  const grossMicros = netUsd * 1_000_000 + 100_000
  const exitPrice = Math.round(entryPriceAtoms / 1000) + grossMicros / 10
  const quantityAtoms = '10000000000'
  const order = {
    parentId: null,
    symbol: 'QQQ',
    type: OrderType.Limit,
    status: OrderStatus.Filled,
    quantityAtoms,
    stopMicros: null,
    protective: false,
  }
  const fill = { symbol: 'QQQ', quantityAtoms, feeMicros: '20000' }
  return {
    date,
    asOf: at(date, '21:35'),
    dayStartAt: at(date, '05:00'),
    calendar: { openAt: at(date, '14:30'), closeAt: at(date, '21:00') },
    openingEquityMicros: usdMicros(20_000),
    openingPositions: [],
    positionMarks: [],
    reconciliation: {
      at: at(date, '21:31'),
      positionsAt: at(date, '21:30'),
      exact: true,
      coversActivity: true,
      positionCount: 0,
      positions: [],
    },
    postedFeeDebitMicros: '60000',
    pendingFees: 0,
    missingFillEvents: 0,
    unverifiedDecisions: 0,
    market: { bars: [], quotes: [] },
    controller: [
      {
        id: 'healthy',
        at: at(date, '21:00'),
        noAdmissibleCut: false,
        closeMarketDataUnavailable: false,
        closeWindowExpired: false,
      },
    ],
    entries: [
      {
        id: secret,
        symbol: 'QQQ',
        side: OrderSide.Buy,
        sleeve: IntradayAlphaPhase.NoiseAreaTrend,
        quantityAtoms,
        signalMicros: '100000000',
        referenceMicros: '100000000',
        holdMinutes: 65,
      },
    ],
    orders: [
      {
        ...order,
        id: email,
        entryId: secret,
        side: OrderSide.Buy,
        openedAt: at(date, '15:00'),
        terminalAt: at(date, '15:01'),
        limitMicros: '101000000',
        exitReferenceMicros: null,
      },
      {
        ...order,
        id: 'exit-order',
        entryId: null,
        side: OrderSide.Sell,
        openedAt: at(date, '15:30'),
        terminalAt: at(date, '15:31'),
        limitMicros: String(exitPrice),
        exitReferenceMicros: String(exitPrice),
      },
    ],
    fills: [
      {
        ...fill,
        id: 'entry-fill',
        orderId: email,
        at: at(date, '15:01'),
        side: OrderSide.Buy,
        priceAtoms: String(entryPriceAtoms),
        realizedMicros: '0',
      },
      {
        ...fill,
        id: 'exit-fill',
        orderId: 'exit-order',
        at: at(date, '15:31'),
        side: OrderSide.Sell,
        priceAtoms: `${exitPrice}000`,
        realizedMicros: String(grossMicros),
      },
    ],
  }
}

const manifestFor = (coreAccountId = coreId, canaryAccountId = canaryId, canaryMode = SleeveMode.PaperSubmit) =>
  Result.getOrThrow(
    decodeManifest(
      JSON.stringify({
        schemaVersion: 'bayn.multi-account-daily-sleeves-config.v1',
        intradayAccountId: intradayId,
        sleeves: [
          {
            sleeveId: 'core',
            strategy: Strategy.MacroEtfCore,
            profile: RunnerProfile.F4,
            accountId: coreAccountId,
            credentialsEnvPrefix: 'CORE',
            capitalBudgetUsd: 10_000,
            mode: SleeveMode.PaperSubmit,
          },
          {
            sleeveId: 'canary',
            strategy: Strategy.MacroCanaryEtf,
            profile: CanaryProfile.O1,
            accountId: canaryAccountId,
            credentialsEnvPrefix: 'CANARY',
            capitalBudgetUsd: 10_000,
            mode: canaryMode,
          },
        ],
      }),
      true,
    ),
  )

const raw = (signalSession: string, price: number) => ({
  t: at(signalSession, '05:00'),
  c: price,
  o: price,
  h: price,
  l: price,
  v: 10_000,
})
const weights = Object.fromEntries(
  macroCanaryEtfs.map((symbol) => [symbol, symbol === 'QQQ' ? 0.25 : 0]),
) as MacroCanaryEtfTarget['targetWeights']

const nextOpen = (index: number, reviewPlanSha?: string, manifest = manifestFor()) => {
  const signalSession = signalDates[index]
  const executionSession = dates[index]
  const coreBinding = manifest.sleeves.find(({ profile }) => profile === RunnerProfile.F4)!
  const canaryBinding = manifest.sleeves.find(({ profile }) => profile === CanaryProfile.O1)!
  const { sleeveId, accountId, capitalBudgetCents, activeSymbols } = canaryBinding
  const review = index === 0
  const resumedRotation =
    reviewPlanSha === undefined ? null : { signalSession: signalDates[0], planSha256: reviewPlanSha }
  const session = { signalSession, executionSession }
  const targets = universe.map((symbol) => ({ symbol, weight: symbol === 'QQQ' || symbol === 'SHY' ? 0.5 : 0 }))
  const coreMaterial = {
    ...session,
    schemaVersion: 'bayn.macro-etf-core-next-open-sleeve-receipt.v1',
    broker: 'alpaca-paper',
    profile: RunnerProfile.F4,
    configuredExclusions: [],
    configuredBudgetCents: 1_000_000,
    signalCloseAt: at(signalSession, '21:00'),
    executionOpenAt: at(executionSession, '14:30'),
    tif: TimeInForce.Open,
    barSha256: sha,
    snapshotSha256: sha,
    signalBars: {
      feed: sip,
      timeframe: '1Day',
      adjustment: 'all',
      sessions: 253,
      snapshotSha256: sha,
      missingCandidates: [],
    },
    rawSizingBars: {
      feed: sip,
      timeframe: '1Day',
      adjustment: 'raw',
      rows: [
        { symbol: 'QQQ', bar: raw(signalSession, 300) },
        { symbol: 'SHY', bar: raw(signalSession, 100) },
      ],
    },
    allocation: {
      components: [
        {
          profile: Profile.F4,
          policyHash: sha,
          signal: review
            ? {
                policyHash: sha,
                signalDate: signalSession,
                signalCloseAt: Date.parse(at(signalSession, '21:00')),
                executionDate: executionSession,
                executionOpenAt: Date.parse(at(executionSession, '14:30')),
                weights: targets.map(({ weight }) => weight),
              }
            : null,
        },
      ],
      excludedSymbols: [],
      targets: review ? targets : null,
    },
    plan: {
      blocked: null,
      rebalanceDue: review,
      budgetCents: 1_000_000,
      cashCents: 1_000_000,
      buyingPowerCents: 1_000_000,
      equityCents: 1_000_000,
      managedGrossCents: 0,
      overnightCapCents: 15_000_000,
      intradayCapCents: 18_000_000,
      maximumProjectedGrossCents: 0,
      remainingIntradayGrossCents: 18_000_000,
      buyLimitNotionalCents: 0,
      orders: [],
      reviewDue: review,
      collarBps: 15,
      deadbandBps: 1000,
      reservedGrossCents: 0,
    },
  } as const satisfies Omit<CorePlanReceipt, 'mode' | 'timestamp' | 'planSha256'>
  const core = {
    ...coreMaterial,
    mode: coreBinding.mode,
    timestamp: at(executionSession, '14:00'),
    planSha256: hash(coreMaterial),
  }
  const phase = review
    ? RotationPhase.Reduce
    : index === 1 && resumedRotation !== null
      ? RotationPhase.Increase
      : RotationPhase.Hold
  const holdReason =
    phase !== RotationPhase.Hold
      ? null
      : resumedRotation === null
        ? HoldReason.OutsideReview
        : HoldReason.NoWholeShareDrift
  const canaryMaterial = {
    ...session,
    schemaVersion: 'bayn.macro-canary-next-open-sleeve-receipt.v1',
    broker: 'alpaca-paper',
    mode: canaryBinding.mode,
    marketSha256: sha,
    snapshotSha256: sha,
    sleeveSha256: hash({ sleeveId, accountId, capitalBudgetCents, activeSymbols }),
    observedAt: at(executionSession, '14:00'),
    resumedRotation,
    effectiveTargetWeights: weights,
    target: {
      signalSession,
      nextOpenSession: executionSession,
      review,
      policyHash: sha,
      targetWeights: weights,
      attribution: {
        canary: { reviewedAt: signalSession, offCount: 0, defensiveBudget: 0, scores: { TLT: 1 }, weights },
        trend: { zScores: { QQQ: 1 }, weights },
        macro: {
          regime: 'DeflationaryCrash',
          credit: 0,
          inflation: 0,
          dollar: 0,
          strongDollar: false,
          unsmoothedWeights: weights,
          weights,
        },
        blendWeights: { canary: 1, trend: 0, macro: 0 },
        ensembleWeights: weights,
        idleShyWeight: 0,
        unsweptCashWeight: 0.75,
      },
    } satisfies MacroCanaryEtfTarget,
    rawSizingBars: [{ symbol: 'QQQ', bar: raw(signalSession, 300) }],
    budgetCents: 1_000_000,
    spendableCents: 1_000_000,
    remainingOneWayTurnoverBps: review || resumedRotation !== null ? 2000 : null,
    phase,
    holdReason,
    orders:
      phase === RotationPhase.Hold
        ? []
        : [
            {
              request: {
                symbol: 'QQQ',
                side: phase === RotationPhase.Reduce ? Side.Sell : Side.Buy,
                qty: '1',
                type: 'limit',
                time_in_force: TimeInForce.Open,
                limit_price: '300.00',
                extended_hours: false,
                client_order_id: `${orderPrefix(accountId, executionSession)}QQQ`,
              },
            },
          ],
  } as const satisfies Omit<CanaryPlanReceipt, 'planSha256' | 'target'> & { target: MacroCanaryEtfTarget }
  const canary = { ...canaryMaterial, planSha256: hash(canaryMaterial) }
  const receipt = Result.getOrThrow(
    makePortfolioReceipt(manifest, [
      {
        sleeveId: coreBinding.sleeveId,
        accountId: coreBinding.accountId,
        verifiedAccountId: coreBinding.accountId,
        disposition: 'no-orders',
        error: null,
        plan: {
          ...session,
          receipt: core,
          targetExposure: review
            ? targets.map(({ symbol, weight }) => ({ symbol, targetCents: Math.floor(weight * core.plan.budgetCents) }))
            : null,
        },
      },
      {
        sleeveId,
        accountId,
        verifiedAccountId: accountId,
        error: null,
        disposition:
          canaryBinding.mode === SleeveMode.Shadow ? 'shadow' : canary.orders.length > 0 ? 'submitted' : 'no-orders',
        plan: {
          ...session,
          receipt: canary,
          targetExposure:
            review || resumedRotation !== null
              ? macroCanaryEtfs.map((symbol) => ({
                  symbol,
                  targetCents: Math.floor(weights[symbol] * canary.budgetCents),
                }))
              : null,
        },
      },
    ]),
  )
  return { receipt, reviewSha: canary.planSha256 }
}

const fixture = (count: number = dates.length, slipBps = 1) => {
  const audit = analyzeProfitability({
    schemaVersion: 'bayn.live-profitability-evidence.v1',
    sessions: dates.slice(0, count).map((date, i) => auditSession(date, 20 * (i + 1), slipBps)),
  })
  const review = nextOpen(0)
  const sleeveReceipts = [
    review.receipt,
    ...dates.slice(1, count).map((_, i) => nextOpen(i + 1, i < 2 ? review.reviewSha : undefined).receipt),
  ]
  const series = (accountId: string, net: readonly number[], notional: readonly number[]) => {
    let equity = 10_000
    return sleeveReceipts.map(({ portfolioSha256 }, i) => {
      const openingEquityMicros = usdMicros(equity)
      equity += net[i]
      return {
        accountId,
        portfolioSha256,
        openingEquityMicros,
        closingEquityMicros: usdMicros(equity),
        netExternalCashFlowMicros: '0',
        tradedNotionalMicros: usdMicros(notional[i]),
      }
    })
  }
  return {
    audit,
    sleeveReceipts,
    accountEvidence: {
      schemaVersion: 'bayn.weekly-attribution-evidence.v1',
      intraday: { accountId: intradayId, auditSha256: hash(audit) },
      macroSessions: [
        ...series(coreId, [10, -100, -20, 120, 10], [1800, 0, 0, 0, 0]),
        ...series(canaryId, [30, 20, -10, 20, 50], [500, 600, 0, 0, 0]),
      ],
    },
  }
}

test('rolls up five aligned sessions, including capital-weighted combined returns and compounded drawdown', () => {
  const report = Result.getOrThrow(buildWeeklyAttributionReport(fixture()))
  const { intraday, macroCore, macroCanary } = report.accounts
  expect(report.week.sessions).toEqual([...dates])
  expect(report.status).toBe(AttributionStatus.Qualifying)
  expect(intraday.netPnlMicros).toBe('300000000')
  expect(intraday.annualizedSharpe).toBeCloseTo((Math.sqrt(252) * 0.003) / Math.sqrt(0.0000025), 8)
  expect(intraday.maxDrawdown).toBe(0)
  expect(intraday.slippage).toEqual({
    status: AttributionStatus.Qualifying,
    meanBps: 1,
    medianBps: 1,
    budgetBps: 2.5,
    complete: true,
    samples: 5,
  })
  expect(macroCore.netPnlMicros).toBe('20000000')
  expect(macroCore.maxDrawdown).toBeCloseTo(120 / 10010, 9)
  expect(macroCore.turnover).toBeCloseTo(0.18, 9)
  expect(macroCore.wholeShareTrackingDrift).toMatchObject({
    maxBps: 200,
    fullBudgetReviews: 1,
    reviews: [{ date: dates[0], budgetCents: 1_000_000, residualMicros: '200000000', bps: 200 }],
  })
  expect(macroCanary.netPnlMicros).toBe('110000000')
  expect(macroCanary.maxDrawdown).toBeCloseTo(10 / 10050, 9)
  expect(macroCanary.rotation).toEqual({
    status: RotationStatus.Complete,
    reviewSignalSession: signalDates[0],
    lastActionableSession: dates[2],
  })
  expect(report.combined.netPnlMicros).toBe('430000000')
  expect(report.combined.maxDrawdown).toBeCloseTo(40 / 40040, 9)
  expect(report.combined.tradedNotionalMicros).toBe('13201500000')
  expect(report.combined.turnover).toBeCloseTo(13_201.5 / 40_000, 9)
  expect(report.combined.annualizedSharpe).toBeCloseTo(13.1468494867, 8)
})

test('uses raw round trips to detect a >2.5 bp breach that would round down in the audit summary', () => {
  const input = fixture(1, 2.5000001)
  expect(input.audit.sessions[0].slippageGate.meanBps).toBe(2.5)
  const result = Result.getOrThrow(buildWeeklyAttributionReport(input))
  expect(result.status).toBe(AttributionStatus.Breach)
  expect(result.accounts.intraday.slippage.status).toBe(AttributionStatus.Breach)
  expect(result.accounts.intraday.slippage.meanBps).toBeGreaterThan(2.5)
  expect(result.combined.annualizedSharpe).toBeNull()
  const atBudget = Result.getOrThrow(buildWeeklyAttributionReport(fixture(1, 2.5)))
  expect(atBudget.accounts.intraday.slippage.status).toBe(AttributionStatus.Watch)
  expect(atBudget.accounts.intraday.status).toBe(AttributionStatus.Breach) // Daily live promotion is strictly below budget.
})

test('missing account readback never turns orders into fills, nor an unbound audit into portfolio P&L', () => {
  const { audit, sleeveReceipts } = fixture(2)
  const report = Result.getOrThrow(buildWeeklyAttributionReport({ audit, sleeveReceipts }))
  expect(report.status).toBe(AttributionStatus.Watch)
  expect(report.accounts.intraday.identityBound).toBe(false)
  expect(report.accounts.macroCore.netPnlMicros).toBeNull()
  expect(report.accounts.macroCanary.tradedNotionalMicros).toBeNull()
  expect(report.accounts.macroCanary.rotation.status).toBe(RotationStatus.Pending)
  expect(report.combined.netPnlMicros).toBeNull()
  expect(report.combined.maxDrawdown).toBeNull()
  const review = nextOpen(0)
  const shadowReceipt = nextOpen(2, review.reviewSha, manifestFor(coreId, canaryId, SleeveMode.Shadow)).receipt
  const shadow = Result.getOrThrow(
    buildWeeklyAttributionReport({ audit, sleeveReceipts: [...sleeveReceipts, shadowReceipt] }),
  )
  expect(shadow.accounts.macroCanary.rotation.status).toBe(RotationStatus.Pending)
})

test('subtracts external cash flows without claiming a time-weighted return for the affected series', () => {
  const input = fixture()
  const row = input.accountEvidence.macroSessions[0]
  row.closingEquityMicros = usdMicros(10_510)
  row.netExternalCashFlowMicros = usdMicros(500)
  const report = Result.getOrThrow(buildWeeklyAttributionReport(input))
  expect(report.accounts.macroCore.netPnlMicros).toBe('20000000')
  expect(report.combined.netPnlMicros).toBe('430000000')
  expect(report.combined.annualizedSharpe).toBeNull()
  expect(report.accounts.macroCore.maxDrawdown).toBeNull()
  expect(report.status).toBe(AttributionStatus.Watch)
})

const rehash = <A extends { portfolioSha256: string }>({ portfolioSha256: _old, ...receipt }: A) => ({
  ...receipt,
  portfolioSha256: hash(receipt),
})
const rejects = (input: unknown, kind: string) => {
  const result = buildWeeklyAttributionReport(input)
  expect(Result.isFailure(result)).toBe(true)
  if (Result.isFailure(result)) expect(Redacted.value(result.failure.cause)).toMatchObject({ kind })
}

test('rejects a rehashed ID collision, broker verification mismatch, role swap and cross-wired audit', () => {
  const input = fixture(2)
  const [first, second] = input.sleeveReceipts
  rejects(
    { ...input, sleeveReceipts: [rehash({ ...first, isolation: { ...first.isolation, intradayAccountId: coreId } })] },
    'AccountCollision',
  )
  const crossWired = second.sleeves.map((sleeve) =>
    sleeve.verifiedAccountId === coreId ? { ...sleeve, verifiedAccountId: canaryId } : sleeve,
  )
  rejects({ ...input, sleeveReceipts: [first, rehash({ ...second, sleeves: crossWired })] }, 'AccountMismatch')
  const swapped = nextOpen(1, undefined, manifestFor(canaryId, coreId)).receipt
  rejects({ ...input, sleeveReceipts: [first, swapped] }, 'AccountCrossWiring')
  rejects(
    {
      ...input,
      accountEvidence: { ...input.accountEvidence, intraday: { ...input.accountEvidence.intraday, accountId: coreId } },
    },
    'AuditBindingMismatch',
  )
})

test('checks portfolio integrity and cross-checks included O1 reduction lineage', () => {
  const input = fixture(2)
  const [first, second] = input.sleeveReceipts
  rejects({ ...input, sleeveReceipts: [first, { ...second, portfolioSha256: sha }] }, 'DigestMismatch')
  rejects({ audit: input.audit, sleeveReceipts: [first, nextOpen(1, sha).receipt] }, 'RotationBindingMismatch')
})

test('retains a valid failed preflight as a breach without leaking its error or dating it as a successful session', () => {
  const {
    audit,
    sleeveReceipts: [first],
  } = fixture(2)
  const manifest = manifestFor()
  const failed = Result.getOrThrow(
    makePortfolioReceipt(
      manifest,
      manifest.sleeves.map(({ sleeveId, accountId }) => ({
        sleeveId,
        accountId,
        verifiedAccountId: null,
        plan: null,
        disposition: 'failed',
        error: { stage: 'reconcile', code: 'AccountUnavailable', cause: { [secret]: email } },
      })),
    ),
  )
  const report = Result.getOrThrow(buildWeeklyAttributionReport({ audit, sleeveReceipts: [first, failed] }))
  expect(report.accounts.macroCore.status).toBe(AttributionStatus.Breach)
  expect(report.accounts.macroCanary.status).toBe(AttributionStatus.Breach)
  expect(report.combined.netPnlMicros).toBeNull()
  expect(renderWeeklyAttributionJson(report)).not.toContain(secret)
  const delta = Result.getOrThrow(buildWeeklyKnowledgeDelta(report, commit))
  expect(delta.rules).toHaveLength(1) // Only the independently verified F4 review is a finding.
  expect(JSON.stringify(delta)).not.toContain(email)
})

test('renders deterministic JSON and Markdown and includes a hash-matched daily scorecard without its prose', () => {
  const input = fixture()
  const scorecard = Result.getOrThrow(buildScorecard({ intraday: [input.audit], macroCore: [], macroCanary: [] }))
  const report = Result.getOrThrow(buildWeeklyAttributionReport({ ...input, scorecard }))
  const permuted = Result.getOrThrow(
    buildWeeklyAttributionReport({
      ...input,
      scorecard,
      sleeveReceipts: input.sleeveReceipts.toReversed(),
      accountEvidence: { ...input.accountEvidence, macroSessions: input.accountEvidence.macroSessions.toReversed() },
    }),
  )
  const markdown = renderWeeklyAttributionMarkdown(report)
  expect(renderWeeklyAttributionJson(permuted)).toBe(renderWeeklyAttributionJson(report))
  expect(renderWeeklyAttributionMarkdown(permuted)).toBe(markdown)
  expect(report.scorecard).toEqual({ gate: Gate.Incomplete, matchedAuditSessions: 5 })
  expect(markdown).toContain('| Combined | **QUALIFYING** | $430.00 |')
  expect(markdown).toContain('**#3 two-phase rotation: COMPLETE.**')
  expect(markdown).not.toContain('Missing macro ETF core receipt')
  rejects(
    {
      ...input,
      scorecard: { ...scorecard, sessions: scorecard.sessions.map((row) => ({ ...row, auditSessionSha256: sha })) },
    },
    'ScorecardBindingMismatch',
  )
})

test('projects only verified aggregate rules and rejects an invalid provenance commit', () => {
  const input = fixture()
  const report = Result.getOrThrow(buildWeeklyAttributionReport(input))
  const delta = Result.getOrThrow(buildWeeklyKnowledgeDelta(report, commit))
  expect(delta).toMatchObject({
    kind: 'knowledge-delta',
    version: 1,
    sourceCommit: commit,
    verificationNote: expect.any(String),
  })
  expect(delta.rules.map(({ name }) => name)).toEqual([
    'Bayn B0 round-trip slippage, week of 2026-12-07',
    'Bayn F4 whole-share sizing drift, week of 2026-12-07',
  ])
  for (const sensitive of [secret, email, intradayId, coreId, canaryId, sha]) {
    expect(JSON.stringify(delta)).not.toContain(sensitive)
    expect(renderWeeklyAttributionJson(report)).not.toContain(sensitive)
  }
  const noVerifiedEvidence = Result.getOrThrow(
    buildWeeklyAttributionReport({ audit: input.audit, sleeveReceipts: [input.sleeveReceipts.at(-1)] }),
  )
  expect(Result.isFailure(buildWeeklyKnowledgeDelta(noVerifiedEvidence, commit))).toBe(true)
  expect(Result.isFailure(buildWeeklyKnowledgeDelta(report, secret))).toBe(true)
  expect(
    Result.isFailure(buildWeeklyKnowledgeDelta({ ...report, week: { ...report.week, start: secret } }, commit)),
  ).toBe(true)
})

test('CLI emits a private proposal, refuses to overwrite, and rejects malformed JSON/schema before output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bayn-weekly-'))
  try {
    const input = fixture(1)
    const audit = join(dir, 'audit.json')
    const portfolio = join(dir, 'portfolio.json')
    const accountEvidence = join(dir, 'account-evidence.json')
    const delta = join(dir, 'knowledge-delta.json')
    const cli = join(import.meta.dir, 'bayn-weekly-attribution-report.ts')
    const args = [
      '--audit',
      audit,
      '--sleeve-receipt',
      portfolio,
      '--account-evidence',
      accountEvidence,
      '--format',
      'json',
    ]
    const run = (output: string) =>
      Bun.spawnSync([process.execPath, cli, ...args, '--emit-knowledge-delta', output, '--source-commit', commit])
    await writeFile(audit, JSON.stringify(input.audit))
    await writeFile(portfolio, JSON.stringify(input.sleeveReceipts[0]))
    await writeFile(accountEvidence, JSON.stringify(input.accountEvidence))

    const success = run(delta)
    expect(success.exitCode).toBe(0)
    expect(success.stdout.toString()).toContain('bayn.weekly-attribution-report.v1')
    const proposal = await readFile(delta, 'utf8')
    expect(proposal).toContain('knowledge-delta')
    expect(proposal).not.toContain(secret)
    expect((await stat(delta)).mode & 0o777).toBe(0o600)

    expect(run(delta).exitCode).not.toBe(0)
    expect(await readFile(delta, 'utf8')).toBe(proposal)
    expect(run(audit).exitCode).not.toBe(0)
    expect(await readFile(audit, 'utf8')).toBe(JSON.stringify(input.audit))

    const invalidPath = join(dir, 'must-not-write.json')
    for (const corrupt of [`{"broken":"${secret}`, JSON.stringify({ ...input.sleeveReceipts[0], [secret]: email })]) {
      await writeFile(portfolio, corrupt)
      const failed = run(invalidPath)
      const logs = failed.stdout.toString() + failed.stderr.toString()
      expect(failed.exitCode).not.toBe(0)
      expect(logs).not.toContain(secret)
      expect(logs).not.toContain(email)
      expect(logs).not.toContain(dir)
      expect(await Bun.file(invalidPath).exists()).toBe(false)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('interrupts outstanding reads, runs their finalizer once, and leaves defects in the defect channel', async () => {
  const args = ['--audit', 'one.json', '--sleeve-receipt', 'two.json']
  let cleaned = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const fiber = yield* runWeeklyAttribution(args).pipe(
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    cleaned++
                  }),
                ),
              ),
          }),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }),
  )
  expect(cleaned).toBe(1)
  const defect = new Error('read defect')
  const exit = await Effect.runPromiseExit(
    runWeeklyAttribution(args).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFileString: () => Effect.die(defect) })),
    ),
  )
  expect(Exit.isFailure(exit) && Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
})
