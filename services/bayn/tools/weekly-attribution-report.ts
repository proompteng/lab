import { Result, Schema } from 'effect'

import { compareIntradayInstants as compareAt } from '../src/market-data/intraday/time'
import { GitSourceRevisionSchema, IsoDateSchema, strictParseOptions } from '../src/schemas'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { microsPerCent } from './macro-canary-runner/planner'
import { intradaySymbols } from './macro-etf-core-runner/contract'
import { SleeveMode } from './multi-account-daily-sleeves/contract'
import { AuditReceipt, AuditVerdict, type AuditSession } from './multi-horizon-scorecard-receipts'
import {
  attributionError,
  Disposition,
  HoldReason,
  macroBudgetCents,
  receiptHash,
  RotationPhase,
  verifyPortfolio,
  WeeklyAttributionInput,
  type MacroAccountSession,
} from './weekly-attribution-receipts'

export enum AttributionStatus {
  Qualifying = 'QUALIFYING',
  Watch = 'WATCH',
  Breach = 'BREACH',
}

export enum RotationStatus {
  Unobserved = 'UNOBSERVED',
  NotDue = 'NOT_DUE',
  NotRequired = 'NO_ROTATION_REQUIRED',
  Pending = 'PENDING',
  Complete = 'COMPLETE',
}

const liveBudgetBps = AuditReceipt.fields.sessions.value.fields.slippageGate.fields.promotionBps.literal
const tradingDaysPerYear = 252
const minimumSharpeSessions = 5
const micros = 1_000_000
const oneDayMs = 86_400_000
const basisPoints = 10_000
const centsToMicros = BigInt(microsPerCent)
const mean = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / values.length
const nz = (quantity: string | null) => quantity !== null && /[1-9]/.test(quantity)
const reject = (message: string, kind: string) => Result.fail(attributionError(message, { kind }))
const decode = Schema.decodeUnknownResult(WeeklyAttributionInput, strictParseOptions)
const money = (value: string | null) => (value === null ? null : BigInt(value))
type VerifiedPortfolio = Result.Result.Success<ReturnType<typeof verifyPortfolio>>

type Day = {
  readonly openingEquity: bigint | null
  readonly net: bigint | null
  readonly turnover: bigint | null
  readonly hasExternalFlow: boolean
}
const missingDay: Day = { openingEquity: null, net: null, turnover: null, hasExternalFlow: false }
const sumKnown = (values: readonly (bigint | null)[]) =>
  values.reduce<bigint | null>((sum, value) => (sum === null || value === null ? null : sum + value), 0n)

const performance = (days: readonly Day[]) => {
  const net = sumKnown(days.map((day) => day.net))
  const turnover = sumKnown(days.map((day) => day.turnover))
  const start = days[0]?.openingEquity ?? null
  const returns = days.flatMap(({ openingEquity, net, hasExternalFlow }) =>
    openingEquity === null || openingEquity <= 0n || net === null || net < -openingEquity || hasExternalFlow
      ? []
      : [Number(net) / Number(openingEquity)],
  )
  let sharpe: number | null = null
  let maxDrawdown: number | null = null
  if (returns.length > 0 && returns.length === days.length) {
    let equity = 1
    let peak = 1
    maxDrawdown = 0
    for (const dailyReturn of returns) {
      equity *= 1 + dailyReturn
      peak = Math.max(peak, equity)
      maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak)
    }
    if (returns.length >= minimumSharpeSessions && returns.some((value) => value !== returns[0])) {
      const average = mean(returns)
      const sampleVariance = returns.reduce((sum, value) => sum + (value - average) ** 2, 0) / (returns.length - 1)
      sharpe = (Math.sqrt(tradingDaysPerYear) * average) / Math.sqrt(sampleVariance)
    }
  }
  return {
    netPnlMicros: net?.toString() ?? null,
    annualizedSharpe: sharpe,
    maxDrawdown,
    tradedNotionalMicros: turnover?.toString() ?? null,
    turnover: turnover === null || start === null || start <= 0n ? null : Number(turnover) / Number(start),
    sessionsWithNetPnl: days.filter((day) => day.net !== null).length,
    sessionsWithReturns: returns.length,
  }
}

const scopeIsV3 = (audit: AuditSession) => {
  const allowed = (symbol: string) => intradaySymbols.some((candidate) => candidate === symbol)
  return !(
    audit.entries.some(({ symbol, sleeve }) => !allowed(symbol) || sleeve !== IntradayAlphaPhase.NoiseAreaTrend) ||
    audit.bySymbol.some(({ symbol, fills }) => fills > 0 && !allowed(symbol)) ||
    audit.bySleeve.some(({ sleeve, fills }) => fills > 0 && sleeve !== IntradayAlphaPhase.NoiseAreaTrend) ||
    audit.positions.some(
      (position) =>
        !allowed(position.symbol) &&
        [position.openingQuantity, position.lastLedgerQuantity, position.lastBrokerQuantity].some(nz),
    )
  )
}

const intradayObservation = (audit: AuditSession) => {
  const { evidence: e, metrics, calendar, slippageGate: gate } = audit
  const openingEquity = money(e.openingEquityMicros)
  const inScope = scopeIsV3(audit)
  const completeFills = inScope && e.missingFillEvents === 0 && e.unresolvedFills === 0 && e.unverifiedDecisions === 0
  const finalized =
    completeFills &&
    calendar !== null &&
    compareAt(audit.asOf, calendar.closeAt) >= 0 &&
    e.eodEvidence &&
    e.positionEvidence &&
    e.reconciliationExact === true &&
    e.positionsAt !== null &&
    compareAt(e.positionsAt, calendar.closeAt) >= 0 &&
    e.reconciliationAt !== null &&
    compareAt(e.reconciliationAt, e.positionsAt) >= 0 &&
    compareAt(audit.asOf, e.reconciliationAt) >= 0 &&
    e.brokerPositionCount === 0 &&
    e.pendingFees === 0 &&
    e.unresolvedOrders === 0 &&
    audit.positions.every(
      (position) =>
        position.lastBrokerQuantity !== null &&
        ![position.openingQuantity, position.lastLedgerQuantity, position.lastBrokerQuantity].some(nz),
    )
  const day: Day = {
    openingEquity,
    net: finalized ? money(metrics.netRealizedMicros) : null,
    turnover: finalized ? BigInt(metrics.tradedNotionalMicros) : null,
    hasExternalFlow: false,
  }
  return {
    day,
    breached: !inScope || audit.verdict === AuditVerdict.Fail || audit.alerts.length > 0,
    measured: completeFills ? (gate.roundTripBps ?? []) : [],
    slippageComplete:
      finalized &&
      (gate.roundTripBps !== undefined || gate.samples === 0) &&
      gate.unmatchedFilledEntries === 0 &&
      gate.unmeasuredRoundTrips === 0 &&
      gate.samples === metrics.roundTrip.samples &&
      metrics.unmeasuredRoundTrips === 0 &&
      (metrics.fills === 0 || gate.samples > 0),
  }
}

const macroObservation = (row: MacroAccountSession): Day => ({
  openingEquity: BigInt(row.openingEquityMicros),
  net: BigInt(row.closingEquityMicros) - BigInt(row.openingEquityMicros) - BigInt(row.netExternalCashFlowMicros),
  turnover: BigInt(row.tradedNotionalMicros),
  hasExternalFlow: BigInt(row.netExternalCashFlowMicros) !== 0n,
})

const badge = (breached: boolean, complete: boolean) =>
  breached ? AttributionStatus.Breach : complete ? AttributionStatus.Qualifying : AttributionStatus.Watch

const pooledSlippage = (observations: readonly ReturnType<typeof intradayObservation>[], expected: number) => {
  const samples = observations.flatMap(({ measured }) => measured).sort((a, b) => a - b)
  const lower = samples[Math.floor((samples.length - 1) / 2)]
  const upper = samples[Math.floor(samples.length / 2)]
  const meanBps = samples.length === 0 ? null : mean(samples)
  const medianBps = lower === undefined || upper === undefined ? null : lower / 2 + upper / 2
  const complete =
    samples.length > 0 && observations.length === expected && observations.every((row) => row.slippageComplete)
  const worst = Math.max(meanBps ?? -Infinity, medianBps ?? -Infinity)
  return {
    samples: samples.length,
    meanBps,
    medianBps,
    budgetBps: liveBudgetBps,
    complete,
    status: badge(worst > liveBudgetBps, complete && worst < liveBudgetBps),
  }
}

const sizingDrift = ({ plan: receipt, outcome }: VerifiedPortfolio['core']) =>
  Result.gen(function* () {
    const targets = outcome.plan?.targetExposure
    if (receipt === undefined || targets == null || outcome.disposition === Disposition.Failed) return null
    const { budgetCents, blocked } = receipt.plan
    if (blocked !== null || budgetCents === 0) return null
    const marks = new Map(receipt.rawSizingBars.rows.map(({ symbol, bar }) => [symbol, bar]))
    if (marks.size !== receipt.rawSizingBars.rows.length)
      return yield* reject('F4 sizing bars contain duplicate symbols', 'DuplicateSizingBar')
    let residual = 0n
    for (const { symbol, targetCents } of targets) {
      if (targetCents === 0) continue
      const bar = marks.get(symbol)
      if (bar === undefined || !bar.t.startsWith(receipt.signalSession) || bar.c < 1 || bar.c > 100_000)
        return yield* reject('F4 sizing target lacks its finalized raw price', 'InvalidSizingBar')
      // The receipt's cent-rounded target and raw pricing isolate share granularity, not collar or fill drift.
      const targetMicros = BigInt(targetCents) * centsToMicros
      residual += targetMicros % BigInt(Math.round(bar.c * micros))
    }
    return {
      budgetCents,
      residualMicros: residual.toString(),
      bps: (basisPoints * Number(residual)) / Number(BigInt(budgetCents) * centsToMicros),
    }
  })

const canaryRotation = (portfolios: readonly VerifiedPortfolio[]) =>
  Result.gen(function* () {
    let status = RotationStatus.Unobserved
    let reviewSignalSession: string | null = null
    let lastActionableSession: string | null = null
    const reviews = new Map<string, NonNullable<VerifiedPortfolio['canary']['plan']>>()
    for (const {
      canary: { plan, outcome },
    } of portfolios) {
      if (plan === undefined) continue
      if (plan.target.review) reviews.set(plan.signalSession, plan)
      if (plan.holdReason === HoldReason.OutsideReview) {
        if (status === RotationStatus.Unobserved && outcome.disposition !== Disposition.Failed)
          status = RotationStatus.NotDue
        continue
      }
      const resumed = plan.resumedRotation
      const prior = resumed === null ? undefined : reviews.get(resumed.signalSession)
      if (
        prior !== undefined &&
        (prior.phase !== RotationPhase.Reduce ||
          prior.mode !== SleeveMode.PaperSubmit ||
          prior.planSha256 !== resumed?.planSha256 ||
          prior.sleeveSha256 !== plan.sleeveSha256 ||
          prior.target.policyHash !== plan.target.policyHash ||
          (yield* receiptHash(prior.effectiveTargetWeights)) !== (yield* receiptHash(plan.effectiveTargetWeights)))
      )
        return yield* reject('O1 resume does not match the retained reduction receipt', 'RotationBindingMismatch')
      reviewSignalSession = resumed?.signalSession ?? plan.signalSession
      lastActionableSession = plan.executionSession
      // Only this successful paper outcome implies the adapter wrote its reconciliation completion marker.
      status =
        outcome.disposition === Disposition.Failed ||
        plan.phase !== RotationPhase.Hold ||
        plan.holdReason !== HoldReason.NoWholeShareDrift
          ? RotationStatus.Pending
          : resumed === null
            ? RotationStatus.NotRequired
            : outcome.disposition === Disposition.NoOrders && plan.mode === SleeveMode.PaperSubmit
              ? RotationStatus.Complete
              : RotationStatus.Pending
    }
    return { status, reviewSignalSession, lastActionableSession }
  })

export const buildWeeklyAttributionReport = (input: unknown) =>
  Result.gen(function* () {
    const { audit, sleeveReceipts, scorecard, accountEvidence } = yield* decode(input).pipe(
      Result.mapError((cause) => attributionError('Invalid weekly attribution input schema', cause)),
    )
    const first = audit.sessions[0]
    if (first === undefined)
      return yield* reject('At least one intraday audit session is required', 'MissingAuditSessions')
    const day = new Date(first.date)
    const monday = day.getTime() - ((day.getUTCDay() + 6) % 7) * oneDayMs
    const dateAt = (offset: number) => new Date(monday + offset * oneDayMs).toISOString().slice(0, 10)
    const start = dateAt(0)
    const friday = dateAt(4)
    const inWeek = (date: string) => date >= start && date <= friday
    const dates = new Set<string>()
    const audits = new Map<string, ReturnType<typeof intradayObservation>>()
    for (const session of audit.sessions) {
      const { date, slippageGate, metrics } = session
      if (!inWeek(date) || audits.has(date))
        return yield* reject('Audit dates must be unique sessions in one trading week', 'InvalidAuditSession')
      const net = money(metrics.netRealizedMicros)
      const gross = money(metrics.realizedMicros)
      if (
        (slippageGate.roundTripBps !== undefined && slippageGate.roundTripBps.length !== slippageGate.samples) ||
        (net !== null &&
          (gross === null ||
            net !== gross - BigInt(metrics.directFeesMicros) - BigInt(metrics.unallocatedPostedFeesMicros)))
      )
        return yield* reject('Audit samples or net P&L do not reconcile', 'InvalidAuditTotals')
      dates.add(date)
      audits.set(date, intradayObservation(session))
    }

    const byHash = new Map<string, VerifiedPortfolio>()
    const byDate = new Map<string, VerifiedPortfolio>()
    let baseline: VerifiedPortfolio | undefined
    for (const [index, receipt] of sleeveReceipts.entries()) {
      const checked = yield* verifyPortfolio(receipt, index)
      if (
        baseline !== undefined &&
        (checked.intradayAccountId !== baseline.intradayAccountId ||
          checked.core.binding.accountId !== baseline.core.binding.accountId ||
          checked.core.binding.sleeveId !== baseline.core.binding.sleeveId ||
          checked.canary.binding.accountId !== baseline.canary.binding.accountId ||
          checked.canary.binding.sleeveId !== baseline.canary.binding.sleeveId)
      )
        return yield* reject('Account role or sleeve ID changed across receipts', 'AccountCrossWiring')
      baseline ??= checked
      if (byHash.has(checked.portfolioSha256)) return yield* reject('Duplicate portfolio receipt', 'DuplicatePortfolio')
      byHash.set(checked.portfolioSha256, checked)
      if (checked.date === undefined) continue // A failed preflight can leave no dated plan.
      if (!inWeek(checked.date) || byDate.has(checked.date))
        return yield* reject('Portfolio dates must be unique sessions in the audit week', 'InvalidPortfolioSession')
      byDate.set(checked.date, checked)
      dates.add(checked.date)
    }

    const binding = accountEvidence?.intraday
    if (
      binding !== undefined &&
      (binding.accountId !== baseline?.intradayAccountId || binding.auditSha256 !== (yield* receiptHash(audit)))
    )
      return yield* reject(
        'Intraday audit digest or account attestation does not match the portfolio',
        'AuditBindingMismatch',
      )

    const coreDays = new Map<string, Day>()
    const canaryDays = new Map<string, Day>()
    for (const row of accountEvidence?.macroSessions ?? []) {
      const matched = byHash.get(row.portfolioSha256)
      if (matched === undefined || matched.date === undefined)
        return yield* reject(
          'Macro account evidence lacks its dated portfolio receipt',
          'MissingAccountEvidenceReceipt',
        )
      const { date } = matched
      const destination =
        row.accountId === matched.core.outcome.verifiedAccountId
          ? coreDays
          : row.accountId === matched.canary.outcome.verifiedAccountId
            ? canaryDays
            : undefined
      if (destination === undefined || destination.has(date))
        return yield* reject(
          'Macro evidence has an unverified or duplicated account/session binding',
          'AccountEvidenceMismatch',
        )
      destination.set(date, macroObservation(row))
    }

    let matchedAuditSessions = 0
    if (scorecard !== undefined) {
      const seen = new Set<string>()
      const rawAudit = new Map(audit.sessions.map((session) => [session.date, session]))
      for (const row of scorecard.sessions) {
        if (seen.has(row.date)) return yield* reject('Duplicate scorecard session', 'DuplicateScorecardSession')
        seen.add(row.date)
        if (!inWeek(row.date)) continue
        if (row.registered) dates.add(row.date)
        const session = rawAudit.get(row.date)
        if (session === undefined || row.auditSessionSha256 === null) continue
        if ((yield* receiptHash(session)) !== row.auditSessionSha256)
          return yield* reject('Scorecard and audit disagree on session evidence', 'ScorecardBindingMismatch')
        matchedAuditSessions++
      }
    }

    const sortedDates = [...dates].sort()
    const sessions = sortedDates.map((date) => ({
      date,
      intraday: audits.get(date)?.day ?? missingDay,
      core: coreDays.get(date) ?? missingDay,
      canary: canaryDays.get(date) ?? missingDay,
    }))
    const slippage = pooledSlippage([...audits.values()], sessions.length)
    const corePortfolios = [...byHash.values()].map(({ core }) => core)
    const canaryPortfolios = [...byHash.values()].map(({ canary }) => canary)
    const dated = sortedDates.flatMap((date) => byDate.get(date) ?? [])
    const sizingReviews = []
    for (const { date, core } of dated) {
      const drift = yield* sizingDrift(core)
      if (drift !== null) sizingReviews.push({ date, ...drift })
    }
    const fullBudgetReviews = sizingReviews.filter((row) => row.budgetCents === macroBudgetCents)
    const rotation = yield* canaryRotation(dated)

    const intraday = performance(sessions.map((row) => row.intraday))
    const macroCore = performance(sessions.map((row) => row.core))
    const macroCanary = performance(sessions.map((row) => row.canary))
    const complete = (summary: ReturnType<typeof performance>) =>
      summary.sessionsWithReturns === sessions.length &&
      summary.turnover !== null &&
      BigInt(summary.netPnlMicros ?? '0') > 0n
    const intradayStatus = badge(
      slippage.status === AttributionStatus.Breach || [...audits.values()].some((row) => row.breached),
      complete(intraday) && binding !== undefined && slippage.status === AttributionStatus.Qualifying,
    )
    const coreStatus = badge(
      corePortfolios.some(
        ({ outcome, plan }) => outcome.error !== null || (plan !== undefined && plan.plan.blocked !== null),
      ),
      complete(macroCore) &&
        dated.length === sessions.length &&
        !corePortfolios.some(({ outcome }) => outcome.disposition === Disposition.Withheld),
    )
    const canaryStatus = badge(
      canaryPortfolios.some(({ outcome }) => outcome.error !== null),
      complete(macroCanary) &&
        dated.length === sessions.length &&
        rotation.status !== RotationStatus.Pending &&
        !canaryPortfolios.some(({ outcome }) => outcome.disposition === Disposition.Withheld),
    )
    const statuses = [intradayStatus, coreStatus, canaryStatus]

    return {
      schemaVersion: 'bayn.weekly-attribution-report.v1',
      week: { start, end: dateAt(6), sessions: sortedDates },
      status: badge(
        statuses.includes(AttributionStatus.Breach),
        statuses.every((status) => status === AttributionStatus.Qualifying),
      ),
      accounts: {
        intraday: { ...intraday, status: intradayStatus, identityBound: binding !== undefined, slippage },
        macroCore: {
          ...macroCore,
          status: coreStatus,
          wholeShareTrackingDrift: {
            reviews: sizingReviews,
            maxBps: sizingReviews.length === 0 ? null : Math.max(...sizingReviews.map((row) => row.bps)),
            fullBudgetReviews: fullBudgetReviews.length,
            fullBudgetMaxBps:
              fullBudgetReviews.length === 0 ? null : Math.max(...fullBudgetReviews.map((row) => row.bps)),
          },
        },
        macroCanary: { ...macroCanary, status: canaryStatus, rotation },
      },
      combined: performance(
        sessions.map(({ intraday, core, canary }) => {
          const accounts = [binding === undefined ? missingDay : intraday, core, canary]
          return {
            openingEquity: sumKnown(accounts.map((row) => row.openingEquity)),
            net: sumKnown(accounts.map((row) => row.net)),
            turnover: sumKnown(accounts.map((row) => row.turnover)),
            hasExternalFlow: accounts.some((row) => row.hasExternalFlow),
          }
        }),
      ),
      scorecard: scorecard === undefined ? null : { gate: scorecard.QUALIFICATION_GATE, matchedAuditSessions },
    } as const
  })

export type WeeklyAttributionReport = Result.Result.Success<ReturnType<typeof buildWeeklyAttributionReport>>

export const renderWeeklyAttributionJson = (report: WeeklyAttributionReport) => JSON.stringify(report, null, 2)

export const renderWeeklyAttributionMarkdown = ({
  week,
  status,
  accounts,
  combined,
  scorecard,
}: WeeklyAttributionReport) => {
  const { slippage, identityBound } = accounts.intraday
  const { wholeShareTrackingDrift: drift } = accounts.macroCore
  const { rotation } = accounts.macroCanary
  const decimal = (n: number | null, scale = 1, suffix = '') =>
    n === null ? '—' : `${(n * scale).toFixed(4)}${suffix}`
  const usd = (n: string | null) => (n === null ? '—' : `$${(Number(n) / micros).toFixed(2)}`)
  const rows = [
    ['#1 Intraday v3 (QQQ + SMH)', accounts.intraday.status, accounts.intraday],
    ['#2 F4 Macro Core', accounts.macroCore.status, accounts.macroCore],
    ['#3 O1 Macro Canary', accounts.macroCanary.status, accounts.macroCanary],
    ['Combined', status, combined],
  ] as const
  return [
    '# Bayn weekly attribution',
    '',
    `**${status}** · ${week.start} through ${week.end} · ${week.sessions.length} observed or registered sessions`,
    '',
    '| Account | Status | Net P&L | Annualized Sharpe | Max drawdown | Traded notional | Weekly turnover | P&L sessions |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      ([label, badge, row]) =>
        `| ${label} | **${badge}** | ${usd(row.netPnlMicros)} | ${decimal(row.annualizedSharpe)} | ${decimal(row.maxDrawdown, 100, '%')} | ${usd(row.tradedNotionalMicros)} | ${decimal(row.turnover, 100, '%')} | ${row.sessionsWithNetPnl}/${week.sessions.length} |`,
    ),
    '',
    `- **#1 B0 slippage: ${slippage.status}.** Mean ${decimal(slippage.meanBps)} bp; median ${decimal(slippage.medianBps)} bp; live budget ${slippage.budgetBps} bp (${slippage.samples} measured round trips${slippage.complete ? '' : '; incomplete evidence'}). Audit account binding: ${identityBound ? 'matched' : 'unattested'}.`,
    `- **#2 whole-share tracking drift (sizing only):** maximum ${decimal(drift.maxBps)} bp across ${drift.reviews.length} sizing reviews (${drift.fullBudgetReviews} at the full $10,000 budget). Not fill or realized position drift.`,
    `- **#3 two-phase rotation: ${rotation.status}.** Review signal: ${rotation.reviewSignalSession ?? 'not observed'}; last actionable evidence session: ${rotation.lastActionableSession ?? 'not observed'}. Submitted orders are not fills.`,
    ...(scorecard === null
      ? []
      : [
          `- **Daily qualification scorecard: ${scorecard.gate}.** ${scorecard.matchedAuditSessions} audit sessions matched; the upstream gate may span a wider window.`,
        ]),
    '',
    '— = unavailable or not estimable. Badges describe evidence, not permission to trade.',
  ].join('\n')
}

// Rules-only subset of the collective-knowledge curator's strict knowledge-delta v1 contract.
const KnowledgeDelta = Schema.Struct({
  kind: Schema.Literal('knowledge-delta'),
  version: Schema.Literal(1),
  sourceCommit: GitSourceRevisionSchema,
  verificationNote: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
  rules: Schema.NonEmptyArray(
    Schema.Struct({
      name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
      description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_000)),
    }),
  ),
})

const isSessionDate = Schema.is(IsoDateSchema)

export const buildWeeklyKnowledgeDelta = (report: WeeklyAttributionReport, sourceCommit: string) => {
  const { start } = report.week
  if (!isSessionDate(start)) return reject('Invalid week in knowledge delta evidence', 'InvalidWeek')
  const { slippage, identityBound } = report.accounts.intraday
  const drift = report.accounts.macroCore.wholeShareTrackingDrift
  const rules = []
  // Only constant text and derived dates/counts/numbers enter the file, never receipt prose, paths or identifiers.
  if (identityBound && slippage.complete && slippage.meanBps !== null && slippage.medianBps !== null)
    rules.push({
      name: `Bayn B0 round-trip slippage, week of ${start}`,
      description: `Compare pooled measured B0 round trips with the ${slippage.budgetBps} bp live budget. Over ${slippage.samples} matched round trips, adverse mean was ${slippage.meanBps.toFixed(6)} bp and median was ${slippage.medianBps.toFixed(6)} bp. This week is an observation, not a promotion decision.`,
    })
  if (drift.fullBudgetMaxBps !== null)
    rules.push({
      name: `Bayn F4 whole-share sizing drift, week of ${start}`,
      description: `For a funded $10,000 F4 sizing review, measure whole-share residual against the cent-rounded target at the raw signal-session close. The maximum residual across ${drift.fullBudgetReviews} verified reviews was ${drift.fullBudgetMaxBps.toFixed(6)} bp of budget. Do not interpret modeled sizing drift as realized execution drift.`,
    })
  if (rules.length === 0)
    return reject('No verified slippage or full-budget sizing evidence for a knowledge delta', 'NoVerifiedKnowledge')
  return Schema.decodeUnknownResult(
    KnowledgeDelta,
    strictParseOptions,
  )({
    kind: 'knowledge-delta',
    version: 1,
    sourceCommit,
    verificationNote:
      'Recomputed from schema-validated weekly evidence: account-bound audit round trips or account-verified and digest-checked F4 sizing at finalized raw references. No individual trading records are included.',
    rules,
  }).pipe(Result.mapError((cause) => attributionError('Invalid weekly knowledge delta', cause)))
}
