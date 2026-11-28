import { Data, Redacted, Result, Schema } from 'effect'

import { canonicalHashV1Result, canonicalJsonV1Result } from '../src/hash'
import { compareIntradayInstants as compareAt, intradayInstantNanos } from '../src/market-data/intraday/time'
import { sipUniverse } from '../src/market-data/sip/universe'
import { strictParseOptions } from '../src/schemas'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'
import { Profile } from '../src/strategy/macro-etf-core/policy'
import { Side } from './macro-canary-runner/alpaca'
import { cents, intradayCapCents, microsPerCent, overnightCapCents } from './macro-canary-runner/planner'
import { intradaySymbols, RunnerProfile } from './macro-etf-core-runner/contract'
import {
  AuditAlert,
  AuditReceipt,
  type AuditSession,
  CanaryReceipt,
  CoreReceipt,
  QualificationFile,
  SessionCalendar,
  SipReceipt,
} from './multi-horizon-scorecard-receipts'

const sessionMinimum = 20
const promotionBps = 2.5
const breakevenBps = 11.2
const microsInCent = BigInt(microsPerCent)
const overnightCapMicros = BigInt(overnightCapCents) * microsInCent
const combinedCapMicros = BigInt(intradayCapCents) * microsInCent

export enum Gate {
  Pass = 'PASS',
  Fail = 'FAIL',
  Incomplete = 'INCOMPLETE',
}

export class ScorecardError extends Data.TaggedError('ScorecardError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

export const scorecardError = (message: string, cause: unknown) =>
  new ScorecardError({ message, cause: Redacted.make(cause) })

const Input = Schema.Struct({
  intraday: Schema.Array(AuditReceipt),
  macroCore: Schema.Array(CoreReceipt),
  macroCanary: Schema.Array(CanaryReceipt),
  sip: Schema.optionalKey(Schema.Array(SipReceipt)),
  qualification: Schema.optionalKey(QualificationFile),
})
type Session = typeof SessionCalendar.Type
type Proof = (typeof QualificationFile.Type)['proofs'][number]
type Macro = CoreReceipt | CanaryReceipt

const decode = Schema.decodeUnknownResult(Input, strictParseOptions)
const fail = (message: string, cause: unknown) => Result.fail(scorecardError(message, cause))
const hash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(Result.mapError((cause) => scorecardError('Cannot hash scorecard evidence', cause)))

const index = <A>(rows: readonly A[], key: (row: A) => string, label: string) => {
  const byDate = new Map<string, A>()
  for (const row of rows) {
    const date = key(row)
    if (byDate.has(date)) return fail(`Duplicate ${label} session: ${date}`, { _tag: 'DuplicateSession', label, date })
    byDate.set(date, row)
  }
  return Result.succeed(byDate)
}

const verifyMacro = (receipt: Macro) =>
  Result.gen(function* () {
    // Both runners hash the entire immutable plan material, excluding these envelope fields.
    const { planSha256, mode, timestamp, ...material } = receipt
    const { executionSession: date } = receipt
    if ((yield* hash(material)) !== planSha256)
      return yield* fail(`Macro plan SHA-256 mismatch: ${date} (${receipt.schemaVersion})`, {
        _tag: 'DigestMismatch',
        field: 'planSha256',
        date,
      })
    if (
      receipt.signalSession >= date ||
      !receipt.signalCloseAt.startsWith(receipt.signalSession) ||
      !receipt.executionOpenAt.startsWith(date) ||
      compareAt(receipt.signalCloseAt, timestamp) >= 0 ||
      compareAt(timestamp, receipt.executionOpenAt) >= 0
    )
      return yield* fail(`Invalid macro receipt time cut: ${date}`, { _tag: 'InvalidTimeCut', date, mode })
    return receipt
  })

const matchesCalendar = (source: { readonly openAt: string; readonly closeAt: string }, calendar: Session) =>
  compareAt(source.openAt, calendar.openAt) === 0 && compareAt(source.closeAt, calendar.closeAt) === 0

const gross = (receipt: Macro) => {
  const plan = receipt.plan
  const reportedCurrent =
    BigInt(plan.managedGrossCents) +
    BigInt('reservedGrossCents' in plan ? plan.reservedGrossCents : plan.otherGrossCents)
  const brokerGross = receipt.reconciliation.positions.reduce(
    (sum, position) => sum + BigInt(cents(position.market_value.replace(/^-/, ''), true)),
    0n,
  )
  const current = max(reportedCurrent, brokerGross)
  const buysAtLimit = plan.orders.reduce(
    (sum, { request }) =>
      sum + (request.side === Side.Buy ? BigInt(request.qty) * BigInt(cents(request.limit_price)) : 0n),
    0n,
  )
  return { current, reportedCurrent, brokerGross, projected: BigInt(plan.maximumProjectedGrossCents), buysAtLimit }
}
const max = (a: bigint, b: bigint) => (a > b ? a : b)
const isIntraday = (symbol: string) => intradaySymbols.some((candidate) => candidate === symbol)
const nonzero = (quantity: string | null) => quantity !== null && /[1-9]/.test(quantity)

const validateMacroSession = (receipt: Macro, label: string, calendar?: Session, previous?: Session) => {
  const { current, reportedCurrent, brokerGross, projected, buysAtLimit } = gross(receipt)
  const critical: string[] = []
  const missing: string[] = []
  if (
    receipt.plan.blocked !== null ||
    receipt.reconciliation.openOrders.length > 0 ||
    receipt.reconciliation.account.account_blocked ||
    receipt.reconciliation.account.trading_blocked ||
    receipt.reconciliation.account.trade_suspended_by_user
  )
    critical.push(`${label} plan blocked or reconciliation has open orders`)
  const positions = receipt.reconciliation.positions.map(({ symbol }) => symbol)
  if (new Set(positions).size !== positions.length || reportedCurrent < brokerGross)
    critical.push(`${label} inventory gross does not cover the broker reconciliation`)
  if (projected < current + buysAtLimit)
    critical.push(`${label} projected gross understates current inventory and buy limits`)
  if (max(projected, current + buysAtLimit) * microsInCent > overnightCapMicros)
    critical.push(`${label} projected gross exceeds $150,000`)
  if (
    (calendar !== undefined && compareAt(receipt.executionOpenAt, calendar.openAt) !== 0) ||
    (previous !== undefined &&
      (receipt.signalSession !== previous.date || compareAt(receipt.signalCloseAt, previous.closeAt) !== 0))
  )
    critical.push(`${label} signal/next-open calendar mismatch`)

  const orders = receipt.plan.orders.map(({ request }) => request.symbol)
  if (new Set(orders).size !== orders.length) critical.push(`${label} has duplicate planned order symbols`)
  const targets =
    'allocation' in receipt
      ? (receipt.allocation.targets ?? [])
      : receipt.plan.sizing.map(({ symbol, targetWeight }) => ({ symbol, weight: targetWeight }))
  const excluded = 'allocation' in receipt ? receipt.allocation.excludedSymbols : receipt.plan.excludedSymbols
  for (const symbol of intradaySymbols) {
    if (targets.some((row) => row.symbol === symbol && row.weight > 0) || orders.includes(symbol))
      critical.push(`${label} overlaps intraday v3: ${symbol} has positive effective target weight or a planned order`)
    else if (!excluded.includes(symbol))
      missing.push(`${label} does not explicitly exclude ${symbol} from every overnight review`)
  }
  if ('allocation' in receipt) {
    const { components, targets } = receipt.allocation
    const profiles =
      receipt.profile === RunnerProfile.Equal
        ? [Profile.F2, Profile.F4]
        : [receipt.profile === RunnerProfile.F2 ? Profile.F2 : Profile.F4]
    if (
      components.length !== profiles.length ||
      profiles.some((profile) => components.filter((row) => row.profile === profile).length !== 1) ||
      receipt.plan.reviewDue !== (targets !== null) ||
      components.some(({ signal, policyHash }) =>
        signal === null
          ? targets !== null
          : targets === null ||
            signal.policyHash !== policyHash ||
            signal.signalDate !== receipt.signalSession ||
            signal.executionDate !== receipt.executionSession ||
            BigInt(signal.signalCloseAt) * 1_000_000n !== intradayInstantNanos(receipt.signalCloseAt) ||
            BigInt(signal.executionOpenAt) * 1_000_000n !== intradayInstantNanos(receipt.executionOpenAt),
      )
    )
      critical.push(`${label} allocation does not bind the selected profile and session`)
  }
  return { critical, missing }
}

const inventoryKey = ({ reconciliation: { positions } }: Macro) =>
  JSON.stringify(
    positions.map(({ symbol, qty, side }) => [symbol, qty, side]).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  )

const overnightGross = (core: CoreReceipt, canary: CanaryReceipt) => {
  const a = gross(core)
  const b = gross(canary)
  const coreBuys = max(a.projected - a.current, a.buysAtLimit)
  const canaryBuys = max(b.projected - b.current, b.buysAtLimit)
  if (core.reconciliation.account.id !== canary.reconciliation.account.id)
    return a.current + b.current + coreBuys + canaryBuys
  if (inventoryKey(core) !== inventoryKey(canary)) return null
  // Shared account: count the marked baseline once at its more adverse value and reserve BOTH buy plans.
  return max(a.current, b.current) + coreBuys + canaryBuys
}

const summary = (values: readonly number[]) => {
  const sorted = values.toSorted((a, b) => a - b)
  const n = sorted.length
  const lower = sorted[Math.floor((n - 1) / 2)]
  const upper = sorted[Math.floor(n / 2)]
  return {
    samples: n,
    meanBps: n === 0 ? null : sorted.reduce((sum, value) => sum + value / n, 0),
    medianBps: lower === undefined || upper === undefined ? null : lower / 2 + upper / 2,
  }
}

const verifyAudit = (audit: AuditSession, proof: Proof | undefined, calendar: Session | undefined) => {
  const { evidence, metrics, slippageGate: slips, positions } = audit
  const atClose = audit.calendar?.closeAt
  const critical: string[] = [...new Set(audit.alerts)]
  const missing: string[] = []
  const mark = (alert: AuditAlert, triggered: boolean) => {
    if (triggered && !critical.includes(alert)) critical.push(alert)
  }
  const gap = Math.max(
    metrics.gapThroughIncidents,
    audit.protectiveStops.filter((row) => row.gapThrough !== null).length,
  )
  const stranded = Math.max(
    metrics.nonFlatEodPositions,
    audit.eodNonFlat.length,
    atClose !== undefined && compareAt(audit.asOf, atClose) >= 0
      ? positions.filter((row) => nonzero(row.lastLedgerQuantity) || nonzero(row.lastBrokerQuantity)).length
      : 0,
  )
  mark(AuditAlert.Gap, gap > 0)
  mark(AuditAlert.Stranded, stranded > 0)
  mark(AuditAlert.NoCut, audit.controller.noAdmissibleCut > 0)
  mark(AuditAlert.CloseData, audit.controller.closeMarketDataUnavailable > 0)
  mark(AuditAlert.CloseExpired, audit.controller.closeWindowExpired > 0)
  mark(
    AuditAlert.RegularClose,
    metrics.regularCloseBreaches > 0 ||
      audit.regularCloseBreaches.length > 0 ||
      positions.some((row) => nonzero(row.regularCloseQuantity)),
  )
  mark(AuditAlert.TimedExit, metrics.timedExitBreaches > 0 || audit.timedExitBreaches.length > 0)
  mark(AuditAlert.LateActivity, audit.postCloseOrderIds.length > 0 || audit.postCloseFillIds.length > 0)
  mark(
    AuditAlert.Reconciliation,
    evidence.reconciliationExact === false ||
      (evidence.positionEvidence && positions.some((row) => row.lastLedgerQuantity !== row.lastBrokerQuantity)),
  )
  mark(
    AuditAlert.Working,
    atClose !== undefined && compareAt(audit.asOf, atClose) >= 0 && evidence.unresolvedOrders > 0,
  )

  if (calendar !== undefined && audit.calendar !== null && !matchesCalendar(audit.calendar, calendar))
    critical.push('Intraday audit regular-session calendar mismatch')
  if (
    atClose === undefined ||
    compareAt(audit.asOf, atClose) < 0 ||
    !evidence.eodEvidence ||
    !evidence.positionEvidence ||
    evidence.reconciliationExact !== true ||
    evidence.positionsAt === null ||
    compareAt(evidence.positionsAt, atClose) < 0 ||
    evidence.reconciliationAt === null ||
    compareAt(evidence.reconciliationAt, evidence.positionsAt) < 0 ||
    compareAt(audit.asOf, evidence.reconciliationAt) < 0 ||
    evidence.brokerPositionCount === null ||
    positions.some((row) => row.lastBrokerQuantity === null || row.regularCloseQuantity === null)
  )
    missing.push('Exact, activity-bound post-close broker and ledger evidence is incomplete')
  if (positions.some((row) => nonzero(row.openingQuantity))) critical.push('Prior-session intraday inventory carry')
  if (
    audit.entries.some((row) => !isIntraday(row.symbol) || row.sleeve !== IntradayAlphaPhase.NoiseAreaTrend) ||
    audit.bySleeve.some((row) => row.fills > 0 && row.sleeve !== IntradayAlphaPhase.NoiseAreaTrend) ||
    audit.bySymbol.some((row) => row.fills > 0 && !isIntraday(row.symbol))
  )
    critical.push('Intraday evidence includes fills or entries outside Pure-ETF v3')
  if (audit.controller.passes === 0) missing.push('No observed controller passes')
  if (evidence.openingEquityMicros === null || evidence.openingEquityMicros === '0')
    missing.push('Positive opening equity is unverified')
  for (const [label, count] of [
    ['Pending fees', evidence.pendingFees],
    ['Unresolved orders', evidence.unresolvedOrders],
    ['Missing fill events', evidence.missingFillEvents],
    ['Unresolved fills', evidence.unresolvedFills],
    ['Unverified decisions', evidence.unverifiedDecisions],
  ] as const)
    if (count > 0) missing.push(`${label}: ${count}`)
  if (audit.entries.some((row) => nonzero(row.filledQuantityAtoms) && row.holdMinutes === null))
    missing.push('Filled entry is missing its holding deadline')
  if (
    evidence.brokerPositionCount !== null &&
    evidence.brokerPositionCount !== positions.filter((row) => nonzero(row.lastBrokerQuantity)).length
  )
    critical.push('Broker position count does not match audited inventory')
  const samples = slips.roundTripBps
  const noTrips = metrics.fills === 0 && slips.samples === 0
  if (
    slips.unmatchedFilledEntries > 0 ||
    slips.unmeasuredRoundTrips > 0 ||
    (samples === undefined && !noTrips) ||
    (samples !== undefined && samples.length !== slips.samples) ||
    (!noTrips &&
      (slips.samples === 0 || slips.samples !== metrics.roundTrip.samples || metrics.unmeasuredRoundTrips > 0))
  )
    missing.push('Complete individual B0 round-trip slippage samples are unavailable')

  const net = metrics.netRealizedMicros === null ? null : BigInt(metrics.netRealizedMicros)
  if (net === null || metrics.realizedMicros === null) missing.push('Net realized P&L is unavailable')
  else if (
    net !==
    BigInt(metrics.realizedMicros) - BigInt(metrics.directFeesMicros) - BigInt(metrics.unallocatedPostedFeesMicros)
  )
    critical.push('Net realized P&L does not reconcile to realized P&L and fees')

  if (proof === undefined) missing.push('Receipt-bound PAPER v3 scope, peak gross and risk/cost proof is missing')
  else if (!proof.stopEvidenceComplete) missing.push('Stop-limit gap-through observation coverage is incomplete')

  return { critical, missing, gap, stranded, net, samples: samples ?? [] }
}

const summarizeSip = (sip: SipReceipt, calendar?: Session) => {
  if (calendar !== undefined && !matchesCalendar(sip.session, calendar))
    return { gate: Gate.Fail, blockingChecks: ['SIP session calendar mismatch'] }
  const { checks, pass } = sip.gate
  const pooled = sip.pooled.sip
  const spreadSymbols = ['QQQ', 'SMH', 'XLK']
  const coverage = [...spreadSymbols, ...sipUniverse.benchmarks]
  const bySymbol = new Map(sip.bySymbol.map((row) => [row.symbol, row.sip]))
  const universePass =
    sip.universe.observedHash === sipUniverse.symbolHash &&
    sip.universe.observedCount === sipUniverse.all73.length &&
    sip.universe.mismatchedSipRows === 0 &&
    sip.universe.missing.length === 0 &&
    sip.universe.unexpected.length === 0
  const requiredChecks = new Map([
    ['sip-universe', universePass],
    ...coverage.map(
      (symbol) => [`sip-bar-coverage:${symbol}`, (bySymbol.get(symbol)?.barCoverage ?? 0) >= 0.995] as const,
    ),
    ['sip-crossed-quotes', pooled.crossedQuotes === 0],
    ['sip-quote-ingest-latency', pooled.quoteIngestLatencyMs.p95 !== null && pooled.quoteIngestLatencyMs.p95 < 2_000],
    ...spreadSymbols.map((symbol) => {
      const median = bySymbol.get(symbol)?.spreadBps.median
      return [`sip-median-spread:${symbol}`, median != null && median <= 2] as const
    }),
  ])
  const checkIds = new Set(checks.map(({ id }) => id))
  const failedChecks = checks
    .filter((row) => !row.pass)
    .map(({ id }) => id)
    .sort()
  const consistent =
    checkIds.size === requiredChecks.size &&
    checks.length === checkIds.size &&
    bySymbol.size === sip.bySymbol.length &&
    checks.every((row) => requiredChecks.get(row.id) === row.pass) &&
    pass === (failedChecks.length === 0) &&
    sip.universe.id === sipUniverse.id &&
    sip.universe.expectedHash === sipUniverse.symbolHash
  return {
    gate: !consistent || !pass ? Gate.Fail : Gate.Pass,
    blockingChecks: consistent ? failedChecks : ['SIP gate or universe evidence is inconsistent'],
    observedSymbols: sip.universe.observedCount,
    pooledBarCoverage: sip.pooled.sip.barCoverage,
    pooledQuoteIngestP95Ms: sip.pooled.sip.quoteIngestLatencyMs.p95,
    medianSpreadCompressionBps: sip.commonSymbolSpreads.medianSpreadCompressionBps,
  }
}

const str = (value: bigint | null) => (value === null ? null : value.toString())
const total = (values: readonly (bigint | null)[]) =>
  values.length === 0 || values.some((value) => value === null)
    ? null
    : values.reduce<bigint>((sum, value) => sum + (value ?? 0n), 0n)

export const buildScorecard = (input: unknown) =>
  Result.gen(function* () {
    const receipts = yield* decode(input).pipe(
      Result.mapError((cause) => scorecardError('Invalid scorecard receipt or qualification schema', cause)),
    )
    const audits = yield* index(
      receipts.intraday.flatMap((audit) => audit.sessions),
      ({ date }) => date,
      'intraday audit',
    )
    const cores = yield* index(receipts.macroCore, ({ executionSession }) => executionSession, 'macro ETF core')
    const canaries = yield* index(receipts.macroCanary, ({ executionSession }) => executionSession, 'macro canary')
    const sip = yield* index(receipts.sip ?? [], (receipt) => receipt.session.date, 'SIP shadow')
    const calendar = yield* index(receipts.qualification?.calendar ?? [], ({ date }) => date, 'registered calendar')
    const proofs = yield* index(receipts.qualification?.proofs ?? [], ({ date }) => date, 'PAPER proof')
    for (const session of calendar.values()) {
      if (
        !session.openAt.startsWith(session.date) ||
        !session.closeAt.startsWith(session.date) ||
        compareAt(session.openAt, session.closeAt) >= 0
      )
        return yield* fail(`Invalid registered session calendar: ${session.date}`, {
          _tag: 'InvalidSessionCalendar',
          date: session.date,
        })
    }
    for (const receipt of [...cores.values(), ...canaries.values()]) yield* verifyMacro(receipt)
    const auditHashes = new Map<string, string>()
    for (const [date, audit] of audits) auditHashes.set(date, yield* hash(audit))
    for (const [date, proof] of proofs) {
      if (!calendar.has(date))
        return yield* fail(`PAPER proof is outside the registered calendar: ${date}`, {
          _tag: 'UnregisteredPaperProof',
          date,
        })
      const auditHash = auditHashes.get(date)
      if (auditHash !== undefined && auditHash !== proof.auditSessionSha256)
        return yield* fail(`Intraday audit SHA-256 mismatch: ${date}`, {
          _tag: 'DigestMismatch',
          field: 'auditSessionSha256',
          date,
        })
    }

    const dates = [
      ...new Set([...calendar.keys(), ...audits.keys(), ...cores.keys(), ...canaries.keys(), ...sip.keys()]),
    ].sort()
    const registered = [...calendar.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    const previous = new Map<string, Session | undefined>(registered.map((row, i) => [row.date, registered[i - 1]]))

    const qualificationSha256 = receipts.qualification === undefined ? null : yield* hash(receipts.qualification)

    const rows = dates.map((date) => {
      const session = calendar.get(date)
      const proof = proofs.get(date)
      const audit = audits.get(date)
      const core = cores.get(date)
      const canary = canaries.get(date)
      const shadow = sip.get(date)
      const critical: string[] = []
      const missing: string[] = []
      const paperDate = session !== undefined || audit !== undefined || core !== undefined || canary !== undefined
      if (paperDate && session === undefined) missing.push('No registered PAPER session calendar binding')
      const intraday = audit === undefined ? null : verifyAudit(audit, proof, session)
      if (intraday === null) {
        if (paperDate) missing.push('Missing intraday audit')
      } else {
        critical.push(...intraday.critical)
        missing.push(...intraday.missing)
      }
      for (const [receipt, label] of [
        [core, 'Macro ETF core'],
        [canary, 'Macro canary'],
      ] as const) {
        if (receipt === undefined) {
          if (paperDate) missing.push(`Missing ${label} receipt`)
        } else {
          const checked = validateMacroSession(receipt, label, session, previous.get(date))
          critical.push(...checked.critical)
          missing.push(...checked.missing)
        }
      }
      const overnightCents = core === undefined || canary === undefined ? null : overnightGross(core, canary)
      if (overnightCents === null && core !== undefined && canary !== undefined)
        missing.push('Overnight receipts disagree on shared account inventory')
      const overnight = overnightCents === null ? null : overnightCents * microsInCent
      const peak = proof === undefined || audit === undefined ? null : BigInt(proof.intradayPeakGrossMicros)
      const known = [core, canary].flatMap((receipt) => (receipt === undefined ? [] : [gross(receipt)]))
      const minimumOvernight = known.reduce(
        (bound, { current, projected, buysAtLimit }) =>
          max(bound, max(projected, current + buysAtLimit) * microsInCent),
        0n,
      )
      const combined = overnight === null || peak === null ? null : overnight + peak
      if (overnight !== null && overnight > overnightCapMicros)
        critical.push('Combined overnight gross exceeds $150,000')
      if (peak !== null && (overnight ?? minimumOvernight) + peak > combinedCapMicros)
        critical.push('Overnight plus intraday peak gross exceeds $180,000')
      if (peak === 0n && audit !== undefined && audit.metrics.fills > 0)
        critical.push('Reported intraday peak gross is zero despite fills')

      const net = intraday?.net ?? null
      return {
        date,
        registered: session !== undefined,
        auditSessionSha256: auditHashes.get(date) ?? null,
        paperProofSha256: proof?.sourceSha256 ?? null,
        critical,
        missing,
        intradayPeakGrossMicros: str(peak),
        overnightGrossMicros: str(overnight),
        combinedGrossMicros: str(combined),
        net,
        adjusted: net === null || proof === undefined ? null : net - BigInt(proof.riskCostMicros),
        samples: intraday?.samples ?? [],
        gapThroughCount: intraday?.gap ?? null,
        noAdmissibleCutCount: audit?.controller.noAdmissibleCut ?? null,
        eodStrandedCount: intraday?.stranded ?? null,
        macroCore: core === undefined ? null : { profile: core.profile, mode: core.mode, planSha256: core.planSha256 },
        macroCanary: canary === undefined ? null : { profile: 'O1', mode: canary.mode, planSha256: canary.planSha256 },
        sip:
          shadow === undefined
            ? { gate: Gate.Incomplete, blockingChecks: ['Missing SIP shadow parity receipt'] }
            : summarizeSip(shadow, session),
        iexSipDrift: audit?.marketDrift ?? [],
      }
    })
    const paperRows = rows.filter(
      ({ date }) => calendar.has(date) || audits.has(date) || cores.has(date) || canaries.has(date),
    )
    const qualified = paperRows.filter((row) => row.registered)
    const clean = qualified.filter((row) => row.critical.length === 0 && row.missing.length === 0).length
    const analyzed = receipts.qualification === undefined ? paperRows : qualified
    const slippage = summary(analyzed.flatMap((row) => row.samples))
    const adjusted = total(qualified.map((row) => row.adjusted))
    const critical = paperRows.flatMap((row) => row.critical.map((reason) => `${row.date}: ${reason}`))
    const missing = paperRows.flatMap((row) => row.missing.map((reason) => `${row.date}: ${reason}`))
    if (clean < sessionMinimum) missing.push(`Need ${sessionMinimum} clean PAPER sessions; observed ${clean}`)
    if (slippage.medianBps === null) missing.push('No measured B0 round trips in the selected sessions')
    else if (slippage.medianBps > promotionBps)
      critical.push(`Pooled B0 median ${slippage.medianBps} bp exceeds ${promotionBps} bp`)
    if (adjusted === null) missing.push('Cumulative risk-adjusted net is unavailable for the registered window')
    else if (adjusted <= 0n && qualified.length >= sessionMinimum)
      critical.push('Cumulative risk-adjusted net is not positive')
    const count = (key: 'gapThroughCount' | 'noAdmissibleCutCount' | 'eodStrandedCount') =>
      analyzed.reduce((sum, row) => sum + (row[key] ?? 0), 0)
    let cumulative: bigint | null = 0n
    let rolling20NetMicros: string | null = null
    const economicsByDate = new Map(
      analyzed.map((row, i) => {
        cumulative = cumulative === null || row.net === null ? null : cumulative + row.net
        if (i + 1 >= sessionMinimum)
          rolling20NetMicros = str(total(analyzed.slice(i + 1 - sessionMinimum, i + 1).map((row) => row.net)))
        return [row.date, { cumulativeNetMicros: str(cumulative), rolling20NetMicros }]
      }),
    )
    const last = analyzed.at(-1)
    const latest = last === undefined ? undefined : economicsByDate.get(last.date)
    return {
      schemaVersion: 'bayn.multi-horizon-scorecard.v1',
      QUALIFICATION_GATE: critical.length > 0 ? Gate.Fail : missing.length > 0 ? Gate.Incomplete : Gate.Pass,
      blockingReasons: [...critical, ...missing],
      qualificationSha256,
      registeredSessions: qualified.length,
      cleanPaperSessions: clean,
      observedAuditSessions: analyzed.filter((row) => row.gapThroughCount !== null).length,
      intraday: {
        cumulativeNetMicros: latest?.cumulativeNetMicros ?? null,
        rolling20NetMicros: latest?.rolling20NetMicros ?? null,
        cumulativeRiskAdjustedNetMicros: str(adjusted),
        slippage: {
          ...slippage,
          promotionBps,
          breakevenBps,
          medianBelowBreakeven: slippage.medianBps === null ? null : slippage.medianBps < breakevenBps,
          meanBelowBreakeven: slippage.meanBps === null ? null : slippage.meanBps < breakevenBps,
        },
        gapThroughCount: count('gapThroughCount'),
        noAdmissibleCutCount: count('noAdmissibleCutCount'),
        eodStrandedCount: count('eodStrandedCount'),
      },
      sessions: rows.map(({ net, adjusted, samples, ...row }) => ({
        ...row,
        ...(economicsByDate.get(row.date) ?? { cumulativeNetMicros: null, rolling20NetMicros: null }),
        netMicros: str(net),
        riskAdjustedNetMicros: str(adjusted),
        slippage: summary(samples),
      })),
    } as const
  })

type Scorecard = Result.Result.Success<ReturnType<typeof buildScorecard>>
export const renderScorecardJson = (scorecard: Scorecard) =>
  canonicalJsonV1Result(scorecard).pipe(Result.mapError((cause) => scorecardError('Cannot serialize scorecard', cause)))

const dollars = (micros: string | null) => {
  if (micros === null) return '—'
  const value = BigInt(micros)
  const absolute = value < 0n ? -value : value
  const cents = (absolute + 5_000n) / microsInCent
  return `${value < 0n ? '-' : ''}$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}
const breakeven = (below: boolean | null) => (below === null ? 'unmeasured' : below ? 'below' : 'at or above')
const bp = (value: number | null) => (value === null ? '—' : value.toFixed(4))

export const renderScorecardMarkdown = (scorecard: Scorecard): string => {
  const { intraday, sessions } = scorecard
  const slips = intraday.slippage
  return [
    '# Bayn multi-horizon daily paper qualification',
    '',
    `**QUALIFICATION_GATE: ${scorecard.QUALIFICATION_GATE}** · ${scorecard.cleanPaperSessions}/${sessionMinimum} required clean PAPER sessions`,
    '',
    `- Intraday net: ${dollars(intraday.cumulativeNetMicros)} cumulative / ${dollars(intraday.rolling20NetMicros)} last 20 sessions; risk-adjusted cumulative: ${dollars(intraday.cumulativeRiskAdjustedNetMicros)}.`,
    `- B0 round-trip slippage: ${bp(slips.medianBps)} median / ${bp(slips.meanBps)} mean bp (n=${slips.samples}); median gate ≤ ${slips.promotionBps} bp, research breakeven ${slips.breakevenBps.toFixed(2)} bp (median / mean: ${breakeven(slips.medianBelowBreakeven)} / ${breakeven(slips.meanBelowBreakeven)}).`,
    `- Observed anomalies (${scorecard.observedAuditSessions} audited sessions): ${intraday.gapThroughCount} stop-limit gap-through, ${intraday.noAdmissibleCutCount} NO_ADMISSIBLE_CUT, ${intraday.eodStrandedCount} stranded at EOD.`,
    ...scorecard.blockingReasons.map((reason) => `- Blocker: ${reason}`),
    '',
    '| Execution session | Intraday net | Cumulative | Rolling 20 | Overnight gross | Intraday peak | Combined gross | Core | Canary | SIP shadow |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |',
    ...sessions.map(
      (row) =>
        `| ${row.date} | ${dollars(row.netMicros)} | ${dollars(row.cumulativeNetMicros)} | ${dollars(row.rolling20NetMicros)} | ${dollars(row.overnightGrossMicros)} | ${dollars(row.intradayPeakGrossMicros)} | ${dollars(row.combinedGrossMicros)} | ${row.macroCore?.profile ?? '—'} | ${row.macroCanary?.profile ?? '—'} | ${row.sip.gate} |`,
    ),
    '',
    ...sessions.flatMap((row) =>
      row.sip.gate === Gate.Fail ? [`- SIP ${row.date}: ${row.sip.blockingChecks.join(', ')}.`] : [],
    ),
    'SIP shadow is a separate feed verdict. This report does not confer broker or capital authority.',
  ].join('\n')
}
