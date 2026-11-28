import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Result, Schema } from 'effect'

import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import type { EquityProviderSession as Session } from '../src/equity-hours'
import { OrderSide, OrderStatus, OrderType } from '../src/execution/contracts'
import { canonicalHashV1Result } from '../src/hash'
import { EquityCutFeed, SipDelayClass, sipTopics } from '../src/market-data/sip/provenance'
import { sipUniverse } from '../src/market-data/sip/universe'
import { IsoDateSchema, type IsoDate } from '../src/schemas'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { macroCanaryEtfs } from '../src/strategy/macro-canary-etf/policy'
import type { MacroCanaryEtfTarget } from '../src/strategy/macro-canary-etf/signals'
import { Profile } from '../src/strategy/macro-etf-core/policy'
import { accountTradingDate } from '../src/time'
import { runLiveGraduation } from './evaluate-live-graduation'
import {
  evaluateLiveGraduation,
  FindingCode,
  MinimumMode,
  renderGraduationMarkdown,
  SipVerdict,
  Sleeve,
  Verdict,
} from './live-graduation-gate-core'
import { analyzeProfitability, decodeAuditInput } from './live-profitability-audit-core'
import { TimeInForce } from './macro-canary-runner/contract'
import { RunnerProfile } from './macro-etf-core-runner/contract'
import {
  CanaryProfile,
  decodeManifest,
  makePortfolioReceipt,
  SleeveMode,
  Strategy,
} from './multi-account-daily-sleeves/contract'
import { AuditAlert, CoreReceipt } from './multi-horizon-scorecard-receipts'
import { compareShadowSnapshot, decodeShadowSnapshot } from './sip-vs-iex-shadow-core'
import {
  Disposition,
  HoldReason,
  RotationPhase,
  type CanaryPlanReceipt,
  type CorePlanReceipt,
} from './weekly-attribution-receipts'

const now = '2026-11-28T05:00:00.000Z'
const blackFriday = '2026-11-27'
const sha = 'b'.repeat(64)
const paperAccounts = {
  B0: '11111111-1234-4234-8123-000000000001',
  F4: '22222222-1234-4234-8123-000000000002',
  O1: '33333333-1234-4234-8123-000000000003',
}
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const hash = (value: unknown) => Result.getOrThrow(canonicalHashV1Result(value))
const plus = (at: string, minutes: number) => new Date(Date.parse(at) + minutes * 60_000).toISOString()
const openingEquityMicros = '10000000000'
const dateOnly = Schema.decodeUnknownSync(IsoDateSchema)
const sipFeed = CoreReceipt.fields.signalBars.fields.feed.literal

const audit = (session: Session, slipBps: number, stranded: boolean, net = 925_000, postedFeeDebit = 10_000) => {
  const { date, regularOpenAt: openAt, regularCloseAt: closeAt } = session
  const order = {
    parentId: null,
    symbol: 'QQQ',
    type: OrderType.Limit,
    status: OrderStatus.Filled,
    quantityAtoms: '1000000000',
    limitMicros: '102000000',
    stopMicros: null,
    protective: false,
  }
  const fill = { symbol: 'QQQ', quantityAtoms: order.quantityAtoms, feeMicros: '20000' }
  const input = Result.getOrThrow(
    decodeAuditInput({
      schemaVersion: 'bayn.live-profitability-evidence.v1',
      sessions: [
        {
          date,
          dayStartAt: `${date}T05:00:00.000Z`,
          asOf: closeAt,
          calendar: { openAt, closeAt },
          openingEquityMicros,
          openingPositions: stranded ? [{ symbol: 'GOOGL', quantityAtoms: '-103000000000' }] : [],
          positionMarks: [],
          reconciliation: {
            at: closeAt,
            positionsAt: closeAt,
            exact: true,
            coversActivity: true,
            positionCount: stranded ? 1 : 0,
            positions: stranded
              ? [{ symbol: 'GOOGL', quantityAtoms: '-103000000000', unrealizedMicros: '-500000000' }]
              : [],
          },
          postedFeeDebitMicros: String(postedFeeDebit),
          pendingFees: 0,
          missingFillEvents: 0,
          unverifiedDecisions: 0,
          market: { bars: [], quotes: [] },
          controller: [
            {
              id: 'pass',
              at: closeAt,
              noAdmissibleCut: false,
              closeMarketDataUnavailable: false,
              closeWindowExpired: false,
            },
          ],
          entries: [
            {
              id: 'entry',
              sleeve: IntradayAlphaPhase.NoiseAreaTrend,
              symbol: 'QQQ',
              side: OrderSide.Buy,
              quantityAtoms: order.quantityAtoms,
              signalMicros: '100000000',
              referenceMicros: '100000000',
              holdMinutes: 60,
            },
          ],
          orders: [
            {
              ...order,
              id: 'buy',
              entryId: 'entry',
              side: OrderSide.Buy,
              openedAt: plus(openAt, 1),
              terminalAt: plus(openAt, 2),
              exitReferenceMicros: null,
            },
            {
              ...order,
              id: 'sell',
              entryId: null,
              side: OrderSide.Sell,
              openedAt: plus(openAt, 29),
              terminalAt: plus(openAt, 30),
              exitReferenceMicros: '101000000',
            },
          ],
          fills: [
            {
              ...fill,
              id: 'buy-fill',
              orderId: 'buy',
              at: plus(openAt, 2),
              side: OrderSide.Buy,
              priceAtoms: String(100_000_000_000 + Math.round(slipBps * 10_000_000)),
              realizedMicros: '0',
            },
            {
              ...fill,
              id: 'sell-fill',
              orderId: 'sell',
              at: plus(openAt, 30),
              side: OrderSide.Sell,
              priceAtoms: '101000000000',
              realizedMicros: String(net + 40_000 + postedFeeDebit),
            },
          ],
        },
      ],
    }),
  )
  const [report] = analyzeProfitability(input).sessions
  return report
}

const manifest = (mode = SleeveMode.PaperSubmit) =>
  Result.getOrThrow(
    decodeManifest(
      JSON.stringify({
        schemaVersion: 'bayn.multi-account-daily-sleeves-config.v1',
        intradayAccountId: paperAccounts.B0,
        sleeves: [
          {
            sleeveId: 'core',
            accountId: paperAccounts.F4,
            strategy: Strategy.MacroEtfCore,
            profile: RunnerProfile.F4,
            credentialsEnvPrefix: 'CORE',
            capitalBudgetUsd: 10_000,
            mode,
          },
          {
            sleeveId: 'canary',
            accountId: paperAccounts.O1,
            strategy: Strategy.MacroCanaryEtf,
            profile: CanaryProfile.O1,
            credentialsEnvPrefix: 'CANARY',
            capitalBudgetUsd: 10_000,
            mode,
          },
        ],
      }),
      true,
    ),
  )
const weights = Object.fromEntries(
  macroCanaryEtfs.map((symbol) => [symbol, symbol === 'SHY' ? 1 : 0]),
) as CanaryPlanReceipt['effectiveTargetWeights']

const planReceipt = (
  previous: Session & { date: IsoDate },
  current: Session & { date: IsoDate },
  mode?: SleeveMode,
) => {
  const configured = manifest(mode)
  const { date: signalSession, regularCloseAt: signalCloseAt } = previous
  const { date: executionSession, regularOpenAt: executionOpenAt } = current
  const sessions = { signalSession, executionSession }
  const timestamp = plus(executionOpenAt, -15)
  const core = {
    ...sessions,
    schemaVersion: 'bayn.macro-etf-core-next-open-sleeve-receipt.v1',
    broker: 'alpaca-paper',
    profile: RunnerProfile.F4,
    configuredExclusions: [],
    configuredBudgetCents: 1_000_000,
    signalCloseAt,
    executionOpenAt,
    tif: TimeInForce.Open,
    barSha256: sha,
    snapshotSha256: sha,
    signalBars: {
      feed: sipFeed,
      timeframe: '1Day',
      adjustment: 'all',
      sessions: 254,
      snapshotSha256: sha,
      missingCandidates: [],
    },
    rawSizingBars: { feed: sipFeed, timeframe: '1Day', adjustment: 'raw', rows: [] },
    allocation: {
      components: [{ profile: Profile.F4, policyHash: sha, signal: null }],
      excludedSymbols: [],
      targets: null,
    },
    plan: {
      blocked: null,
      rebalanceDue: false,
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
      reviewDue: false,
      collarBps: 15,
      deadbandBps: 1_000,
      reservedGrossCents: 0,
    },
  } as const satisfies Omit<CorePlanReceipt, 'mode' | 'timestamp' | 'planSha256'>
  const outcomes = configured.sleeves.map(
    ({ accountId, sleeveId, capitalBudgetCents, activeSymbols, mode, profile }) => {
      const canary = {
        ...sessions,
        schemaVersion: 'bayn.macro-canary-next-open-sleeve-receipt.v1',
        broker: 'alpaca-paper',
        mode,
        marketSha256: sha,
        snapshotSha256: sha,
        sleeveSha256: hash({ accountId, sleeveId, capitalBudgetCents, activeSymbols }),
        observedAt: timestamp,
        target: {
          signalSession,
          nextOpenSession: executionSession,
          review: false,
          policyHash: sha,
          targetWeights: weights,
          attribution: {
            canary: { reviewedAt: signalSession, offCount: 0, defensiveBudget: 0, scores: {}, weights },
            trend: { zScores: {}, weights },
            macro: {
              regime: 'Goldilocks',
              credit: 0,
              inflation: 0,
              dollar: 0,
              strongDollar: false,
              unsmoothedWeights: weights,
              weights,
            },
            blendWeights: { canary: 1, trend: 0, macro: 0 },
            ensembleWeights: weights,
            idleShyWeight: 1,
            unsweptCashWeight: 0,
          },
        },
        resumedRotation: null,
        effectiveTargetWeights: weights,
        rawSizingBars: [],
        budgetCents: 1_000_000,
        spendableCents: 1_000_000,
        remainingOneWayTurnoverBps: null,
        phase: RotationPhase.Hold,
        holdReason: HoldReason.OutsideReview,
        orders: [],
      } as const satisfies Omit<CanaryPlanReceipt, 'planSha256' | 'target'> & { target: MacroCanaryEtfTarget }
      const receipt =
        profile === RunnerProfile.F4
          ? { ...core, mode, timestamp, planSha256: hash(core) }
          : { ...canary, planSha256: hash(canary) }
      return {
        sleeveId,
        accountId,
        verifiedAccountId: accountId,
        disposition: mode === SleeveMode.Shadow ? Disposition.Shadow : Disposition.NoOrders,
        error: null,
        plan: { ...sessions, receipt, targetExposure: null },
      }
    },
  )
  return Result.getOrThrow(makePortfolioReceipt(configured, outcomes))
}

const parity = ({ date, regularOpenAt: openAt, regularCloseAt: closeAt }: Session) => {
  const identity = (symbol: string) => ({
    provider: 'alpaca',
    feed: EquityCutFeed.Sip,
    delay_class: SipDelayClass.RealTimeConsolidated,
    universe_id: sipUniverse.id,
    universe_symbol_hash: sipUniverse.symbolHash,
    schema_version: 1,
    symbol,
  })
  const minutes = (Date.parse(closeAt) - Date.parse(openAt)) / 60_000
  const fixture = Result.getOrThrow(
    decodeShadowSnapshot({
      session: { date, openAt, closeAt },
      bars: ['QQQ', 'SMH', 'XLK', 'SPY'].flatMap((symbol) =>
        Array.from({ length: minutes }, (_, i) => ({
          ...identity(symbol),
          source_topic: sipTopics.bars,
          event_at: plus(openAt, i),
          ingested_at: plus(openAt, i + 1),
          source_partition: 0,
          source_offset: String(i),
          is_final: 1,
          close: 100,
        })),
      ),
      quotes: sipUniverse.all73.map((symbol) => ({
        ...identity(symbol),
        source_topic: sipTopics.quotes,
        event_at: openAt,
        ingested_at: openAt,
        bid_price: 99.995,
        ask_price: 100.005,
        bid_size: 1,
        ask_size: 1,
      })),
    }),
  )
  return Result.getOrThrow(compareShadowSnapshot(fixture))
}

const settled = (sleeve: Sleeve, session: Session, netRealizedMicros: string) => ({
  sleeve,
  date: session.date,
  observedAt: session.regularCloseAt,
  broker: 'alpaca-paper',
  accountId: paperAccounts[sleeve],
  sourceSha256: sha,
  settled: true,
  reconciliationMismatches: 0,
  unmatchedFeeExceptions: 0,
  unresolvedOrders: 0,
  unresolvedFills: 0,
  incidents: [],
  openingEquityMicros,
  netRealizedMicros,
})

const fixture = (asOf = now, b0Count = 20, macroCount = 10, mode?: SleeveMode) => {
  const end = dateOnly(accountTradingDate(asOf))
  const response = Array.from({ length: 36 }, (_, i) =>
    dateOnly(plus(`${end}T00:00:00.000Z`, (i - 35) * 1440).slice(0, 10)),
  )
    .filter((date) => {
      const day = new Date(date).getUTCDay()
      return day !== 0 && day !== 6 && date !== '2026-11-26'
    })
    .map((date) => ({
      date,
      open: '09:30',
      close: date === blackFriday ? '13:00' : '16:00',
      session_open: '0400',
      session_close: '2000',
    }))
  const query = { start: response[0].date, end }
  const { providerSessions: calendar, normalizedResponseHash } = Result.getOrThrow(
    normalizeMarketCalendarResult(response, query),
  )
  const complete = calendar
    .filter(({ regularCloseAt }) => regularCloseAt <= asOf)
    .map((row) => ({ ...row, date: dateOnly(row.date) }))
  const b0 = complete.slice(-b0Count)
  const macro = complete.slice(-macroCount)
  const auditRows = b0.map((session) => audit(session, 1, false))
  const plans = macro.map((session, i) => planReceipt(complete[complete.length - macroCount + i - 1], session, mode))
  const limit = { fraction: 0.02, researchSha256: sha }
  return {
    b0,
    macro,
    auditRows,
    plans,
    sip: complete.slice(-5).map(parity),
    settlement: [
      ...b0.map((session, i) => ({
        ...settled(Sleeve.B0, session, auditRows[i].metrics.netRealizedMicros ?? '0'),
        auditSessionSha256: hash(auditRows[i]),
        feed: EquityCutFeed.Sip,
      })),
      ...macro.flatMap((session, i) =>
        [Sleeve.F4, Sleeve.O1].map((sleeve) => ({
          ...settled(sleeve, session, '0'),
          portfolioSha256: plans[i].portfolioSha256,
        })),
      ),
    ],
    policy: {
      schemaVersion: 'bayn.live-graduation-policy.v1',
      registeredAt: query.start + 'T00:00:00.000Z',
      calendar: { query, response, normalizedResponseHash },
      firstB0Session: b0[0].date,
      firstMacroSession: macro[0].date,
      paperAccounts,
      drawdown95: { B0: limit, F4: limit, O1: limit, portfolio: limit },
    },
  }
}

const original = fixture()
type Fixture = Omit<typeof original, 'policy'> & {
  policy: typeof original.policy & { minimumSessions?: Partial<Record<Sleeve, number>>; minimumMode?: MinimumMode }
}
const files = ({ auditRows, plans, settlement, policy, sip }: Fixture) => ({
  audits: auditRows.map((session) =>
    encode({ schemaVersion: 'bayn.live-profitability-audit.v1', sessions: [session] }),
  ),
  sleeveReceipts: [
    ...plans.map(encode),
    encode({ schemaVersion: 'bayn.live-graduation-settlement.v1', sessions: settlement }),
  ],
  sipEvidence: sip.map(encode),
  policy: encode(policy),
})
const evaluate = (data: Fixture = original, at = now) => Result.getOrThrow(evaluateLiveGraduation(files(data), at))
const replaceAudit = (data: Fixture, replacement: Fixture['auditRows'][number]): Fixture => ({
  ...data,
  auditRows: data.auditRows.map((row) => (row.date === replacement.date ? replacement : row)),
  settlement: data.settlement.map((row) =>
    row.sleeve === Sleeve.B0 && row.date === replacement.date
      ? {
          ...row,
          auditSessionSha256: hash(replacement),
          netRealizedMicros: replacement.metrics.netRealizedMicros ?? '0',
        }
      : row,
  ),
})

test('graduates all three isolated Paper sleeves with 20/10/10 complete sessions, SIP, and verified economics', () => {
  const verdict = evaluate()
  expect(verdict).toMatchObject({
    schemaVersion: 'bayn.live-graduation-verdict.v1',
    verdict: Verdict.Ready,
    sip: SipVerdict.Verified,
    latestCompletedSession: blackFriday,
    minimumMode: MinimumMode.Strict,
    portfolio: { verdict: Verdict.Ready, netRealizedMicros: '9250000', maxRealizedDrawdown: 0 },
  })
  expect(verdict.sleeves.map((sleeve) => [sleeve.sleeve, sleeve.cleanCompletedSessions, sleeve.verdict])).toEqual([
    [Sleeve.B0, 20, Verdict.Ready],
    [Sleeve.F4, 10, Verdict.Ready],
    [Sleeve.O1, 10, Verdict.Ready],
  ])
  expect(verdict.sleeves[0].slippage).toEqual({ samples: 20, meanBps: 1, medianBps: 1, limitBps: 2.5 })
  expect(renderGraduationMarkdown(verdict)).toContain('grants no authority')
})

test.each([
  { label: 'mean equal only', low: 1, high: 31, replace: 1, ready: false },
  { label: 'median equal only', low: 2.5, high: 1, replace: 1, ready: false },
  { label: 'both over', low: 2.51, high: 2.51, replace: 0, ready: false },
  { label: 'both below before display rounding', low: 2.4999996, high: 2.4999996, replace: 0, ready: true },
])('B0 compares unrounded pooled slippage: $label', ({ low, high, replace, ready }) => {
  let data = original
  for (const [i, session] of original.b0.entries())
    data = replaceAudit(data, audit(session, i < replace ? high : low, false))
  const report = evaluate(data)
  expect(report.verdict).toBe(ready ? Verdict.Ready : Verdict.Blocked)
  if (ready) expect(data.auditRows[0].slippageGate.meanBps).toBe(2.5)
  else expect(report.sleeves[0].blockers).toContainEqual({ code: FindingCode.Slippage })
})

test('the 13:00 ET Black Friday non-flat and regular-close incident blocks even with stale or missing evidence', () => {
  const session = original.b0.at(-1)!
  const incident = audit(session, 1, true)
  const report = evaluate(replaceAudit({ ...original, plans: [] }, incident), '2026-12-05T00:00:00.000Z')
  expect(incident.calendar?.closeAt).toBe('2026-11-27T18:00:00.000Z')
  expect(report.verdict).toBe(Verdict.Blocked)
  expect(report.sleeves[0].blockers).toContainEqual({ code: AuditAlert.Stranded, date: blackFriday })
  expect(report.sleeves[0].blockers).toContainEqual({ code: AuditAlert.RegularClose, date: blackFriday })
})

test('fails closed on an interior missing receipt, a pre-close cut, and a calendar that no longer covers today', () => {
  const date = original.macro[1].date
  const missing = evaluate({ ...original, plans: original.plans.filter((_, i) => i !== 1) })
  expect(missing.verdict).toBe(Verdict.Insufficient)
  expect(missing.sleeves[1].gaps).toContainEqual({ code: FindingCode.MissingPlan, date })
  const stale = evaluate({
    ...original,
    settlement: original.settlement.map((row) =>
      row.date === blackFriday && row.sleeve === Sleeve.F4 ? { ...row, observedAt: '2026-11-27T17:59:59.999Z' } : row,
    ),
  })
  expect(stale.verdict).toBe(Verdict.Insufficient)
  expect(stale.sleeves[1].gaps).toContainEqual(expect.objectContaining({ code: FindingCode.Stale, date: blackFriday }))
  expect(evaluate(original, '2026-11-30T23:00:00.000Z').verdict).toBe(Verdict.Insufficient)
  expect(
    evaluate({ ...original, settlement: original.settlement.filter(({ sleeve }) => sleeve === Sleeve.B0) }).verdict,
  ).toBe(Verdict.Insufficient)
})

test('rejects known settlement mismatches and unmatched fees independently of SIP and other receipts', () => {
  const data = {
    ...original,
    settlement: original.settlement.map((row) =>
      row.date === blackFriday ? { ...row, reconciliationMismatches: 1, unmatchedFeeExceptions: 2 } : row,
    ),
  }
  const report = evaluate(data)
  expect(report.verdict).toBe(Verdict.Blocked)
  for (const sleeve of report.sleeves) {
    expect(sleeve.blockers).toContainEqual({ code: AuditAlert.Reconciliation, date: blackFriday })
    expect(sleeve.blockers).toContainEqual({ code: FindingCode.Fees, date: blackFriday })
  }
})

test('blocks an individual and overlapping portfolio drawdown even though B0 is profitable', () => {
  const report = evaluate({
    ...original,
    settlement: original.settlement.map((row) =>
      row.sleeve === Sleeve.O1 && row.date === blackFriday ? { ...row, netRealizedMicros: '-700000000' } : row,
    ),
  })
  expect(report.verdict).toBe(Verdict.Blocked)
  expect(report.sleeves[2]).toMatchObject({
    maxRealizedDrawdown: 0.07,
    blockers: [{ code: FindingCode.Drawdown }],
  })
  expect(report.portfolio.blockers).toContainEqual({ code: FindingCode.Drawdown })
})

test('counts a reconciled losing B0 day but requires positive cumulative net realized P&L', () => {
  const [first] = original.b0
  expect(evaluate(replaceAudit(original, audit(first, 1, false, -1))).verdict).toBe(Verdict.Ready)
  const report = evaluate(replaceAudit(original, audit(first, 1, false, -(19 * 925_000))))
  expect(report.verdict).toBe(Verdict.Blocked)
  expect(report.sleeves[0]).toMatchObject({ netRealizedMicros: '0', cleanCompletedSessions: 20 })
  expect(report.sleeves[0].blockers).toContainEqual({ code: FindingCode.Profit })
})

test('accepts a finalized fee credit without treating it as an unmatched exception', () => {
  const [first] = original.b0
  const credited = audit(first, 1, false, 930_000, -5_000)
  expect(evaluate(replaceAudit(original, credited)).sleeves[0]).toMatchObject({
    verdict: Verdict.Ready,
    netRealizedMicros: '18505000',
  })
})

test('does not mistake shadow plans, missing SIP reports, or an IEX Paper feed for live readiness', () => {
  expect(evaluate(fixture(now, 20, 10, SleeveMode.Shadow)).sleeves[1].blockers).toContainEqual({
    code: FindingCode.Plan,
    date: blackFriday,
  })
  expect(evaluate({ ...original, sip: [] })).toMatchObject({ verdict: Verdict.Blocked, sip: SipVerdict.IexOnly })
  expect(evaluate({ ...original, sip: original.sip.slice(0, -1) }).verdict).toBe(Verdict.Insufficient)
  const data = {
    ...original,
    settlement: original.settlement.map((row) =>
      row.sleeve === Sleeve.B0 && row.date === blackFriday ? { ...row, feed: EquityCutFeed.Iex } : row,
    ),
  }
  expect(evaluate(data)).toMatchObject({ verdict: Verdict.Blocked, sip: SipVerdict.IexOnly })
})

test('checks actual SIP observations rather than trusting a passing flag', () => {
  const sip = original.sip.map((row) =>
    row.session.date === blackFriday
      ? { ...row, pooled: { ...row.pooled, sip: { ...row.pooled.sip, quoteCount: 0 } } }
      : row,
  )
  const report = evaluate({ ...original, sip })
  expect(report.verdict).toBe(Verdict.Blocked)
  expect(report.sip).toBe(SipVerdict.NotVerified)
  expect(report.portfolio.blockers).toContainEqual({ code: FindingCode.Sip, date: blackFriday })
  expect(
    evaluate({ ...original, settlement: original.settlement.filter(({ sleeve }) => sleeve !== Sleeve.B0) }),
  ).toMatchObject({ verdict: Verdict.Insufficient, sip: SipVerdict.NotVerified })
})

test('requires an explicit custom override to lower the default minimums', () => {
  const short = fixture(now, 19, 9)
  expect(evaluate(short).verdict).toBe(Verdict.Insufficient)
  const minimumSessions = { B0: 19, F4: 9, O1: 9 }
  const policy = { ...short.policy, minimumSessions }
  expect(Result.isFailure(evaluateLiveGraduation(files({ ...short, policy }), now))).toBe(true)
  expect(evaluate({ ...short, policy: { ...policy, minimumMode: MinimumMode.CustomOverride } })).toMatchObject({
    verdict: Verdict.Ready,
    minimumMode: MinimumMode.CustomOverride,
  })
  const raised = { ...original.policy, minimumSessions: { B0: 21 } }
  expect(evaluate({ ...original, policy: raised }).verdict).toBe(Verdict.Insufficient)
})

test('hashes all original file bytes by role without depending on file order or local paths', () => {
  const input = files(original)
  const report = Result.getOrThrow(evaluateLiveGraduation(input, now))
  const reversed = Result.getOrThrow(
    evaluateLiveGraduation(
      {
        ...input,
        audits: input.audits.toReversed(),
        sleeveReceipts: input.sleeveReceipts.toReversed(),
        sipEvidence: input.sipEvidence.toReversed(),
      },
      now,
    ),
  )
  expect(reversed).toEqual(report)
  expect(report.evidenceDigestSha256).toMatch(/^[0-9a-f]{64}$/)
  const amended = [...input.audits]
  amended[0] = new TextEncoder().encode(new TextDecoder().decode(amended[0]) + '\n')
  expect(Result.getOrThrow(evaluateLiveGraduation({ ...input, audits: amended }, now)).evidenceDigestSha256).not.toBe(
    report.evidenceDigestSha256,
  )
  expect(Result.isFailure(evaluateLiveGraduation({ ...input, audits: [...amended, amended[0]] }, now))).toBe(true)
})

test('rejects tampered plan hashes and unbound settlement receipts', () => {
  const data = {
    ...original,
    plans: original.plans.map((row, i) => (i === 0 ? { ...row, portfolioSha256: sha } : row)),
  }
  expect(Result.isFailure(evaluateLiveGraduation(files(data), now))).toBe(true)
  const unbound = {
    ...original,
    settlement: original.settlement.map((row) =>
      'auditSessionSha256' in row && row.date === blackFriday ? { ...row, auditSessionSha256: sha } : row,
    ),
  }
  expect(evaluate(unbound).sleeves[0].blockers).toContainEqual(
    expect.objectContaining({ code: FindingCode.Binding, date: blackFriday }),
  )
})

test('rejects a calendar with a dropped session against the registered provider digest', () => {
  const policy = {
    ...original.policy,
    calendar: {
      ...original.policy.calendar,
      response: original.policy.calendar.response.filter(({ date }) => date !== blackFriday),
    },
  }
  expect(Result.isFailure(evaluateLiveGraduation(files({ ...original, policy }), now))).toBe(true)
})

test('CLI writes JSON and Markdown, returns nonzero on incomplete input and redacts corrupt JSON and unreadable paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bayn-graduation-'))
  try {
    const input = files(original)
    const clock = join(directory, 'clock.ts')
    await writeFile(clock, `Date.now = () => ${Date.parse(now)}\n`)
    const set = async (flag: string, inputs: readonly Uint8Array[]) => {
      const paths = await Promise.all(
        inputs.map(async (bytes, i) => {
          const path = join(directory, `${flag}-${i}.json`)
          await writeFile(path, bytes)
          return path
        }),
      )
      return paths.flatMap((path) => [`--${flag}`, path])
    }
    const auditFlags = await set('audit', input.audits)
    const receiptFlags = await set('sleeve-receipts', input.sleeveReceipts)
    const sipFlags = await set('sip-evidence', input.sipEvidence)
    const base = [...auditFlags, ...sipFlags, ...(await set('policy', [input.policy]))]
    const run = (args: string[]) => {
      const command = Bun.spawnSync(
        [process.execPath, '--preload', clock, join(import.meta.dir, 'evaluate-live-graduation.ts'), ...args],
        { env: {} },
      )
      return { code: command.exitCode, out: command.stdout.toString(), err: command.stderr.toString() }
    }
    const ready = run([...base, ...receiptFlags])
    expect(ready).toMatchObject({ code: 0, err: '' })
    expect(JSON.parse(ready.out)).toMatchObject({
      schemaVersion: 'bayn.live-graduation-verdict.v1',
      verdict: Verdict.Ready,
    })
    const incomplete = run(base)
    expect(incomplete.code).not.toBe(0)
    expect(incomplete.err).toBe('')
    expect(JSON.parse(incomplete.out)).toMatchObject({ verdict: Verdict.Insufficient })
    const blocked = run([
      ...auditFlags,
      ...receiptFlags,
      ...(await set('policy', [input.policy])),
      '--format',
      'markdown',
    ])
    expect(blocked.code).not.toBe(0)
    expect(blocked.out).toContain('IEX_ONLY_BLOCKED')
    expect(blocked.out).toContain('graduation: BLOCKED')

    const secretMarker = 'do-not-log-this-synthetic-value'
    const corruptPath = join(directory, secretMarker)
    for (const corrupt of [
      null,
      `{"invalid-array": [ ${secretMarker}`,
      new Uint8Array([0xff]),
      JSON.stringify({ [secretMarker]: null }),
    ]) {
      if (corrupt !== null) await writeFile(corruptPath, corrupt)
      const invalid = run(['--audit', corruptPath])
      expect(invalid.code).not.toBe(0)
      expect(invalid.out).toBe('')
      expect(JSON.parse(invalid.err)).toMatchObject({ error: 'GraduationInputError' })
      expect(invalid.err).not.toContain(secretMarker)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('cancels an outstanding file read once and leaves unexpected defects in the defect channel', async () => {
  const run = (readFile: FileSystem.FileSystem['readFile']) =>
    runLiveGraduation(['--audit', 'unused.json']).pipe(
      Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({ readFile })),
    )
  let cleaned = 0
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const fiber = yield* run(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              cleaned++
            }),
          ),
        ),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
    }),
  )
  expect(cleaned).toBe(1)
  const defect = new Error('synthetic file adapter defect')
  const exit = await Effect.runPromiseExit(run(() => Effect.die(defect)))
  expect(Exit.isFailure(exit) && Result.getOrThrow(Cause.findDefect(exit.cause))).toBe(defect)
})
