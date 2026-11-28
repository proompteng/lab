import { Data, Redacted, Result, Schema } from 'effect'

import { MarketCalendarQueryBase, MarketCalendarResponseSchema } from '../src/broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../src/broker/alpaca/normalizers'
import { canonicalHashV1Result, sha256 } from '../src/hash'
import { compareIntradayInstants as compareAt } from '../src/market-data/intraday/time'
import { EquityCutFeed } from '../src/market-data/sip/provenance'
import { sipUniverse } from '../src/market-data/sip/universe'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema as Count,
  PositiveIntegerSchema,
  Sha256Schema,
  UnitIntervalSchema,
  UtcInstantSchema,
  strictParseOptions,
} from '../src/schemas'
import { accountTradingDate } from '../src/time'
import { summarizeBps } from './live-profitability-audit-core'
import { AccountId } from './macro-canary-runner/alpaca'
import { SleeveMode } from './multi-account-daily-sleeves/contract'
import { Gate, inspectIntradayAudit, summarizeSip } from './multi-horizon-scorecard-core'
import {
  AuditAlert,
  AuditReceipt,
  type AuditSession,
  Micros,
  SipReceipt,
  UnsignedMicros,
} from './multi-horizon-scorecard-receipts'
import { ShadowSessionSchema } from './sip-vs-iex-shadow-core'
import { Disposition, PortfolioReceipt, verifyPortfolio } from './weekly-attribution-receipts'

export enum Sleeve {
  B0 = 'B0',
  F4 = 'F4',
  O1 = 'O1',
}

export enum Verdict {
  Ready = 'READY_FOR_REVIEW',
  Blocked = 'BLOCKED',
  Insufficient = 'INSUFFICIENT_EVIDENCE',
}

export enum MinimumMode {
  Strict = 'STRICT',
  CustomOverride = 'CUSTOM_OVERRIDE',
}

export enum SipVerdict {
  Verified = 'SIP_VERIFIED',
  IexOnly = 'IEX_ONLY_BLOCKED',
  NotVerified = 'SIP_NOT_VERIFIED',
}

const sleeves = [Sleeve.B0, Sleeve.F4, Sleeve.O1] as const
const strictMinimum = { B0: 20, F4: 10, O1: 10 } as const
const sipMinimum = 5
const maxCalendarAgeMs = 5 * 86_400_000
const slippageLimitBps = AuditReceipt.fields.sessions.value.fields.slippageGate.fields.promotionBps.literal
const perSleeve = <S extends Schema.Constraint>(schema: S) => ({
  B0: schema,
  F4: schema,
  O1: schema,
})
const DrawdownLimit = Schema.Struct({ fraction: UnitIntervalSchema, researchSha256: Sha256Schema })
const Policy = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.live-graduation-policy.v1'),
  registeredAt: UtcInstantSchema,
  calendar: Schema.Struct({
    query: MarketCalendarQueryBase,
    response: MarketCalendarResponseSchema,
    normalizedResponseHash: Sha256Schema,
  }),
  firstB0Session: IsoDateSchema,
  firstMacroSession: IsoDateSchema,
  paperAccounts: Schema.Struct(perSleeve(AccountId)),
  minimumMode: Schema.optionalKey(Schema.Enum(MinimumMode)),
  minimumSessions: Schema.optionalKey(Schema.Struct(perSleeve(Schema.optionalKey(PositiveIntegerSchema)))),
  drawdown95: Schema.Struct({ ...perSleeve(DrawdownLimit), portfolio: DrawdownLimit }),
})

const settlementFields = {
  date: IsoDateSchema,
  observedAt: UtcInstantSchema,
  broker: Schema.Literal('alpaca-paper'),
  accountId: AccountId,
  sourceSha256: Sha256Schema,
  settled: Schema.Boolean,
  reconciliationMismatches: Count,
  unmatchedFeeExceptions: Count,
  unresolvedOrders: Count,
  unresolvedFills: Count,
  incidents: Schema.Array(Schema.Literals([AuditAlert.Stranded, AuditAlert.RegularClose])),
  openingEquityMicros: UnsignedMicros.check(Schema.isPattern(/^[1-9]/)),
  netRealizedMicros: Micros,
}
const IntradaySettlement = Schema.Struct({
  ...settlementFields,
  sleeve: Schema.Literal(Sleeve.B0),
  auditSessionSha256: Sha256Schema,
  feed: Schema.Enum(EquityCutFeed),
})
const MacroSettlement = Schema.Struct({
  ...settlementFields,
  sleeve: Schema.Literals([Sleeve.F4, Sleeve.O1]),
  portfolioSha256: Sha256Schema,
})
const DailyReceipt = Schema.Union([
  PortfolioReceipt,
  Schema.Struct({
    schemaVersion: Schema.Literal('bayn.live-graduation-settlement.v1'),
    sessions: Schema.NonEmptyArray(Schema.Union([IntradaySettlement, MacroSettlement])),
  }),
])
type Settlement = typeof IntradaySettlement.Type | typeof MacroSettlement.Type
type Session = typeof ShadowSessionSchema.Type
type VerifiedPortfolio = Result.Result.Success<ReturnType<typeof verifyPortfolio>>
type DatedPortfolio = VerifiedPortfolio & { readonly date: string }

export class GraduationInputError extends Data.TaggedError('GraduationInputError')<{
  readonly message: string
  readonly cause: Redacted.Redacted<unknown>
}> {}

export const graduationInputError = (message: string, cause: unknown) =>
  new GraduationInputError({ message, cause: Redacted.make(cause) })

const fail = (message: string, cause: unknown) => Result.fail(graduationInputError(message, cause))
const hash = (value: unknown) =>
  canonicalHashV1Result(value).pipe(Result.mapError((cause) => graduationInputError('Cannot hash evidence', cause)))

const utf8 = new TextDecoder('utf-8', { fatal: true })
const decodeFiles = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  files: readonly Uint8Array[],
  flag: string,
) => {
  const decode = Schema.decodeUnknownResult(Schema.fromJsonString(schema), strictParseOptions)
  return Result.all(
    files.map((bytes, i) => {
      const message = `Invalid ${flag} JSON or schema (input #${i + 1})`
      return Result.try({ try: () => utf8.decode(bytes), catch: (cause) => graduationInputError(message, cause) }).pipe(
        Result.flatMap((json) => decode(json).pipe(Result.mapError((cause) => graduationInputError(message, cause)))),
      )
    }),
  )
}

export interface EvidenceFiles {
  readonly audits: readonly Uint8Array[]
  readonly sleeveReceipts: readonly Uint8Array[]
  readonly sipEvidence: readonly Uint8Array[]
  readonly policy?: Uint8Array
}

const indexByDate = <A>(rows: readonly A[], date: (row: A) => string, label: string) => {
  const index = new Map<string, A>()
  for (const row of rows) {
    const key = date(row)
    if (index.has(key)) return fail(`Duplicate ${label} session: ${key}`, { kind: 'DuplicateSession', date: key })
    index.set(key, row)
  }
  return Result.succeed(index)
}

export enum FindingCode {
  Calendar = 'CALENDAR_COVERAGE_GAP',
  UnexpectedSession = 'OUTSIDE_COMPLETED_WINDOW',
  Minimum = 'MINIMUM_COMPLETED_SESSIONS',
  MissingAudit = 'MISSING_AUDIT',
  AuditBreach = 'AUDIT_BREACH',
  AuditGap = 'AUDIT_EVIDENCE_GAP',
  Binding = 'EVIDENCE_BINDING_MISMATCH',
  MissingPlan = 'MISSING_DAILY_SLEEVE_RECEIPT',
  Plan = 'PAPER_PLAN_NOT_VERIFIED',
  Stale = 'STALE_OR_FUTURE_CUT',
  MissingSettlement = 'MISSING_SETTLEMENT',
  Settlement = 'INCOMPLETE_SETTLEMENT',
  Fees = 'UNMATCHED_FEE_EXCEPTIONS',
  Unresolved = 'UNRESOLVED_ORDERS_OR_FILLS',
  Profit = 'B0_NET_REALIZED_PNL_NOT_POSITIVE',
  Slippage = 'B0_SLIPPAGE_LIMIT',
  SlippageGap = 'NO_MEASURED_B0_ROUND_TRIPS',
  Drawdown = 'RESEARCH_P95_DRAWDOWN_EXCEEDED',
  Iex = 'IEX_ONLY_BLOCKED',
  MissingSip = 'MISSING_SIP_PARITY_EVIDENCE',
  Sip = 'SIP_PARITY_FAILED',
}

interface Finding {
  readonly code: FindingCode | AuditAlert
  readonly date?: string
  readonly detail?: string
}

class Findings {
  readonly blockers: Finding[] = []
  readonly gaps: Finding[] = []

  get verdict() {
    return this.blockers.length > 0 ? Verdict.Blocked : this.gaps.length > 0 ? Verdict.Insufficient : Verdict.Ready
  }

  report() {
    return { verdict: this.verdict, blockers: this.blockers, gaps: this.gaps }
  }
}

const combine = (statuses: readonly Verdict[]) => {
  if (statuses.includes(Verdict.Blocked)) return Verdict.Blocked
  return statuses.includes(Verdict.Insufficient) ? Verdict.Insufficient : Verdict.Ready
}

interface Realized {
  readonly opening: bigint
  readonly net: bigint
}

const economics = (rows: readonly Realized[], limit: typeof DrawdownLimit.Type | undefined, findings: Findings) => {
  let net = 0n
  const baseline = rows[0]?.opening
  let drawdown = null
  if (baseline !== undefined) {
    drawdown = 0
    let peak = baseline
    for (const row of rows) {
      net += row.net
      const equity = baseline + net
      if (equity > peak) peak = equity
      drawdown = Math.max(drawdown, Number(peak - equity) / Number(peak))
    }
    if (limit !== undefined && drawdown > limit.fraction) findings.blockers.push({ code: FindingCode.Drawdown })
  }
  return {
    netRealizedMicros: baseline === undefined ? null : net.toString(),
    maxRealizedDrawdown: drawdown,
    limit: limit ?? null,
  }
}

const inspectSettlement = (
  row: Settlement,
  session: Session | undefined,
  account: string | undefined,
  now: string,
  findings: Findings,
) => {
  const { date } = row
  if (account !== undefined && row.accountId !== account)
    findings.blockers.push({
      code: FindingCode.Binding,
      date,
      detail: 'Settlement Paper account differs from registration',
    })
  if (row.reconciliationMismatches > 0) findings.blockers.push({ code: AuditAlert.Reconciliation, date })
  if (row.unmatchedFeeExceptions > 0) findings.blockers.push({ code: FindingCode.Fees, date })
  if (row.unresolvedOrders > 0 || row.unresolvedFills > 0)
    findings.blockers.push({ code: FindingCode.Unresolved, date })
  for (const code of [...new Set(row.incidents)].sort()) findings.blockers.push({ code, date })
  if (!row.settled) findings.gaps.push({ code: FindingCode.Settlement, date })
  if (session !== undefined && (compareAt(row.observedAt, session.closeAt) < 0 || compareAt(row.observedAt, now) > 0))
    findings.gaps.push({
      code: FindingCode.Stale,
      date,
      detail: 'Settlement must be captured after close and not in the future',
    })
}

const isAuditAlert = Schema.is(Schema.Enum(AuditAlert))
const inspectB0 = (
  audit: AuditSession,
  session: Session | undefined,
  settlement: Settlement | undefined,
  now: string,
  findings: Findings,
) =>
  Result.gen(function* () {
    const { date } = audit
    const { critical, missing, net, samples } = inspectIntradayAudit(audit, session)
    for (const item of critical)
      findings.blockers.push(
        isAuditAlert(item) ? { code: item, date } : { code: FindingCode.AuditBreach, date, detail: item },
      )
    for (const detail of missing) findings.gaps.push({ code: FindingCode.AuditGap, date, detail })
    if (compareAt(audit.asOf, now) > 0)
      findings.gaps.push({ code: FindingCode.Stale, date, detail: 'Future audit cut' })
    if (audit.evidence.pendingFees > 0) findings.blockers.push({ code: FindingCode.Fees, date })
    if (audit.bySleeve.reduce((total, row) => total + row.fills, 0) !== audit.metrics.fills)
      findings.blockers.push({ code: FindingCode.AuditBreach, date, detail: 'Audit fills are not fully attributed' })
    if (
      settlement?.sleeve === Sleeve.B0 &&
      (settlement.auditSessionSha256 !== (yield* hash(audit)) ||
        (net !== null && BigInt(settlement.netRealizedMicros) !== net) ||
        settlement.openingEquityMicros !== audit.evidence.openingEquityMicros ||
        compareAt(settlement.observedAt, audit.asOf) < 0)
    )
      findings.blockers.push({
        code: FindingCode.Binding,
        date,
        detail: 'Settlement does not bind the audit and its economics',
      })
    return samples
  })

const inspectMacro = (
  sleeve: Sleeve.F4 | Sleeve.O1,
  portfolio: DatedPortfolio,
  session: Session | undefined,
  previous: Session | undefined,
  settlement: Settlement | undefined,
  policy: typeof Policy.Type | undefined,
  findings: Findings,
) => {
  const date = portfolio.date
  const { binding, outcome, plan } = sleeve === Sleeve.F4 ? portfolio.core : portfolio.canary
  if (
    binding.mode !== SleeveMode.PaperSubmit ||
    (outcome.disposition !== Disposition.Submitted && outcome.disposition !== Disposition.NoOrders) ||
    plan === undefined ||
    ('timestamp' in plan && plan.plan.blocked !== null)
  )
    findings.blockers.push({ code: FindingCode.Plan, date })
  if (
    (policy !== undefined &&
      (binding.accountId !== policy.paperAccounts[sleeve] ||
        portfolio.intradayAccountId !== policy.paperAccounts.B0)) ||
    (settlement !== undefined &&
      (settlement.sleeve === Sleeve.B0 ||
        settlement.portfolioSha256 !== portfolio.portfolioSha256 ||
        settlement.accountId !== binding.accountId))
  )
    findings.blockers.push({
      code: FindingCode.Binding,
      date,
      detail: 'Settlement or registration differs from the portfolio receipt',
    })
  if (plan !== undefined && session !== undefined) {
    const observedAt = 'timestamp' in plan ? plan.timestamp : plan.observedAt
    if (
      previous === undefined ||
      plan.signalSession !== previous.date ||
      compareAt(observedAt, previous.closeAt) <= 0 ||
      compareAt(observedAt, session.openAt) >= 0 ||
      ('timestamp' in plan &&
        (compareAt(plan.signalCloseAt, previous.closeAt) !== 0 ||
          compareAt(plan.executionOpenAt, session.openAt) !== 0))
    )
      findings.blockers.push({
        code: FindingCode.Binding,
        date,
        detail: 'Plan does not bind the previous close and next open',
      })
  }
}

const inspectSip = (
  receipts: ReadonlyMap<string, SipReceipt>,
  sessions: readonly Session[],
  iexDates: readonly string[],
  b0ProofComplete: boolean,
  findings: Findings,
) => {
  const required = sessions.slice(-sipMinimum)
  const iexOnly = receipts.size === 0 || iexDates.length > 0
  if (iexOnly) {
    findings.blockers.push({
      code: FindingCode.Iex,
      detail: receipts.size === 0 ? 'No SIP evidence supplied' : 'B0 evidence reports IEX',
    })
    for (const date of iexDates) findings.blockers.push({ code: FindingCode.Iex, date })
  }
  const registered = new Map<string, Session>(sessions.map((session) => [session.date, session]))
  const missing = required.filter(({ date }) => !receipts.has(date))
  if (required.length < sipMinimum)
    findings.gaps.push({ code: FindingCode.MissingSip, detail: 'Need five completed registered sessions' })
  for (const { date } of missing) findings.gaps.push({ code: FindingCode.MissingSip, date })
  let failed = false
  for (const [date, receipt] of [...receipts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const calendar = registered.get(date)
    if (calendar === undefined) {
      findings.gaps.push({ code: FindingCode.MissingSip, date, detail: 'SIP report is outside the completed calendar' })
      failed = true
      continue
    }
    const check = summarizeSip(receipt, calendar)
    const minutes = (Date.parse(calendar.closeAt) - Date.parse(calendar.openAt)) / 60_000
    const { sip } = receipt.pooled
    const symbols = new Set(receipt.bySymbol.map(({ symbol }) => symbol))
    if (
      check.gate !== Gate.Pass ||
      receipt.expectedMinutes !== minutes ||
      symbols.size !== sipUniverse.all73.length ||
      !sipUniverse.all73.every((symbol) => symbols.has(symbol)) ||
      sip.quoteCount === 0 ||
      sip.quoteIngestLatencyMs.count !== sip.quoteCount ||
      receipt.bySymbol.some(
        ({ sip: row }) =>
          row.expectedBars !== minutes ||
          row.barCoverage !== row.barCount / minutes ||
          row.barCount > minutes ||
          row.spreadBps.count > row.quoteCount ||
          (row.spreadBps.count === 0 && row.spreadBps.median !== null) ||
          row.crossedQuotes !== 0,
      )
    ) {
      failed = true
      findings.blockers.push({ code: FindingCode.Sip, date })
    }
  }
  if (iexOnly) return SipVerdict.IexOnly
  if (!b0ProofComplete)
    findings.gaps.push({ code: FindingCode.MissingSip, detail: 'Complete account-bound B0 SIP use is unverified' })
  return failed || missing.length > 0 || required.length < sipMinimum || !b0ProofComplete
    ? SipVerdict.NotVerified
    : SipVerdict.Verified
}

/** The clock and the exact file bytes are inputs; evaluation performs no I/O. */
export const evaluateLiveGraduation = (files: EvidenceFiles, now: string) =>
  Result.gen(function* () {
    yield* Schema.decodeUnknownResult(UtcInstantSchema)(now).pipe(
      Result.mapError((cause) => graduationInputError('Invalid evaluation instant', cause)),
    )
    const audits = yield* decodeFiles(AuditReceipt, files.audits, '--audit')
    const daily = yield* decodeFiles(DailyReceipt, files.sleeveReceipts, '--sleeve-receipts')
    const sipReports = yield* decodeFiles(SipReceipt, files.sipEvidence, '--sip-evidence')
    const [policy] = yield* decodeFiles(Policy, files.policy === undefined ? [] : [files.policy], '--policy')
    const minimumMode = policy?.minimumMode ?? MinimumMode.Strict
    const minimum = { ...strictMinimum, ...policy?.minimumSessions }
    if (minimumMode !== MinimumMode.CustomOverride && sleeves.some((sleeve) => minimum[sleeve] < strictMinimum[sleeve]))
      return yield* fail('Lower session minimums require minimumMode: CUSTOM_OVERRIDE', { kind: 'UnmarkedOverride' })

    const portfolio = new Findings()
    let calendar: readonly Session[] = []
    if (policy === undefined) {
      portfolio.gaps.push({
        code: FindingCode.Calendar,
        detail: 'Missing registered calendar, Paper accounts and research p95 policy',
      })
    } else {
      const { query, response } = policy.calendar
      const normalized = yield* normalizeMarketCalendarResult(response, query).pipe(
        Result.mapError((cause) => graduationInputError('Invalid provider calendar in --policy', cause)),
      )
      if (policy.calendar.normalizedResponseHash !== normalized.normalizedResponseHash)
        return yield* fail('Provider calendar hash mismatch in --policy', { kind: 'DigestMismatch' })
      calendar = yield* Schema.decodeUnknownResult(Schema.Array(ShadowSessionSchema))(
        normalized.providerSessions.map(({ date, regularOpenAt, regularCloseAt }) => ({
          date,
          openAt: regularOpenAt,
          closeAt: regularCloseAt,
        })),
      ).pipe(Result.mapError((cause) => graduationInputError('Invalid regular session bounds in --policy', cause)))
      const first = calendar.find(({ date }) => date === policy.firstB0Session)
      const firstMacroIndex = calendar.findIndex(({ date }) => date === policy.firstMacroSession)
      if (
        first === undefined ||
        firstMacroIndex < 1 ||
        policy.firstMacroSession < policy.firstB0Session ||
        compareAt(policy.registeredAt, first.openAt) >= 0 ||
        query.start > query.end ||
        new Set(Object.values(policy.paperAccounts)).size !== sleeves.length ||
        calendar.some(({ date }) => [0, 6].includes(new Date(date).getUTCDay()))
      )
        return yield* fail('Invalid prospective window or isolated Paper accounts in --policy', {
          kind: 'InvalidRegistration',
        })
      if (query.end < accountTradingDate(now))
        portfolio.gaps.push({
          code: FindingCode.Calendar,
          detail: 'Provider calendar does not cover the current New York date',
        })
    }
    const closed = calendar.filter(
      ({ date, closeAt }) => policy !== undefined && date >= policy.firstB0Session && compareAt(closeAt, now) <= 0,
    )
    const latest = closed.at(-1)
    if (latest !== undefined && Date.parse(now) - Date.parse(latest.closeAt) > maxCalendarAgeMs)
      portfolio.gaps.push({ code: FindingCode.Calendar, detail: 'Latest registered close is over five days old' })
    const previous = new Map<string, Session | undefined>(
      calendar.map(({ date }, index) => [date, calendar[index - 1]]),
    )
    const auditByDate = yield* indexByDate(
      audits.flatMap(({ sessions }) => sessions),
      ({ date }) => date,
      'audit',
    )
    const sipByDate = yield* indexByDate(sipReports, ({ session }) => session.date, 'SIP')
    const settlements: Settlement[] = []
    const plans: DatedPortfolio[] = []
    for (const [i, receipt] of daily.entries()) {
      if (receipt.schemaVersion === 'bayn.live-graduation-settlement.v1') {
        settlements.push(...receipt.sessions)
      } else {
        const plan = yield* verifyPortfolio(receipt, i).pipe(
          Result.mapError((cause) => graduationInputError(cause.message, cause)),
        )
        if (plan.date === undefined)
          portfolio.blockers.push({ code: FindingCode.Plan, detail: 'Portfolio receipt has no prepared session' })
        else plans.push({ ...plan, date: plan.date })
      }
    }
    const planByDate = yield* indexByDate(plans, ({ date }) => date, 'daily portfolio receipt')
    const iexDates: string[] = []
    const samples: number[] = []
    const realizedBySleeve = new Map<Sleeve, ReadonlyMap<string, Realized>>()
    const checks = []
    for (const sleeve of sleeves) {
      const findings = new Findings()
      const start = sleeve === Sleeve.B0 ? policy?.firstB0Session : policy?.firstMacroSession
      const sessions = new Map<string, Session>(
        closed.filter(({ date }) => start !== undefined && date >= start).map((row) => [row.date, row]),
      )
      const proofByDate = yield* indexByDate(
        settlements.filter((row) => row.sleeve === sleeve),
        ({ date }) => date,
        `${sleeve} settlement`,
      )
      const evidenceDates = sleeve === Sleeve.B0 ? auditByDate.keys() : planByDate.keys()
      const dates = [...new Set([...sessions.keys(), ...evidenceDates, ...proofByDate.keys()])].sort()
      const realized = new Map<string, Realized>()
      for (const date of dates) {
        const session = sessions.get(date)
        const proof = proofByDate.get(date)
        const issuesBefore = findings.blockers.length + findings.gaps.length
        if (session === undefined) findings.gaps.push({ code: FindingCode.UnexpectedSession, date })
        if (proof === undefined) findings.gaps.push({ code: FindingCode.MissingSettlement, date })
        else inspectSettlement(proof, session, policy?.paperAccounts[sleeve], now, findings)
        if (sleeve === Sleeve.B0) {
          const audit = auditByDate.get(date)
          if (audit === undefined) findings.gaps.push({ code: FindingCode.MissingAudit, date })
          else {
            const slippage = yield* inspectB0(audit, session, proof, now, findings)
            if (session !== undefined) samples.push(...slippage)
          }
          if (proof?.sleeve === Sleeve.B0 && proof.feed === EquityCutFeed.Iex) iexDates.push(date)
        } else {
          const plan = planByDate.get(date)
          if (plan === undefined) findings.gaps.push({ code: FindingCode.MissingPlan, date })
          else inspectMacro(sleeve, plan, session, previous.get(date), proof, policy, findings)
        }
        if (proof !== undefined && findings.blockers.length + findings.gaps.length === issuesBefore)
          realized.set(date, { opening: BigInt(proof.openingEquityMicros), net: BigInt(proof.netRealizedMicros) })
      }
      realizedBySleeve.set(sleeve, realized)
      if (realized.size < minimum[sleeve]) findings.gaps.push({ code: FindingCode.Minimum })
      const metrics = economics(
        realized.size === sessions.size ? [...realized.values()] : [],
        policy?.drawdown95[sleeve],
        findings,
      )
      const slippage = sleeve === Sleeve.B0 ? { ...summarizeBps(samples), limitBps: slippageLimitBps } : null
      if (slippage !== null) {
        if (slippage.meanBps === null || slippage.medianBps === null)
          findings.gaps.push({ code: FindingCode.SlippageGap })
        else if (slippage.meanBps >= slippageLimitBps || slippage.medianBps >= slippageLimitBps)
          findings.blockers.push({ code: FindingCode.Slippage })
        if (metrics.netRealizedMicros !== null && BigInt(metrics.netRealizedMicros) <= 0n)
          findings.blockers.push({ code: FindingCode.Profit })
      }
      checks.push({
        sleeve,
        ...findings.report(),
        firstSession: start ?? null,
        registeredCompletedSessions: sessions.size,
        cleanCompletedSessions: realized.size,
        minimumCompletedSessions: minimum[sleeve],
        ...metrics,
        slippage,
      })
    }

    const macroDates = closed.filter(({ date }) => policy !== undefined && date >= policy.firstMacroSession)
    const combined: Realized[] = []
    for (const { date } of macroDates) {
      const a = realizedBySleeve.get(Sleeve.B0)?.get(date)
      const b = realizedBySleeve.get(Sleeve.F4)?.get(date)
      const c = realizedBySleeve.get(Sleeve.O1)?.get(date)
      if (a !== undefined && b !== undefined && c !== undefined)
        combined.push({ opening: a.opening + b.opening + c.opening, net: a.net + b.net + c.net })
    }
    const combinedMetrics = economics(
      combined.length === macroDates.length ? combined : [],
      policy?.drawdown95.portfolio,
      portfolio,
    )
    const sip = inspectSip(
      sipByDate,
      closed,
      iexDates,
      realizedBySleeve.get(Sleeve.B0)?.size === closed.length,
      portfolio,
    )
    const verdict = combine([portfolio.verdict, ...checks.map(({ verdict }) => verdict)])
    const fileHashes = {
      audit: files.audits.map(sha256).sort(),
      sleeveReceipts: files.sleeveReceipts.map(sha256).sort(),
      sipEvidence: files.sipEvidence.map(sha256).sort(),
      policy: files.policy === undefined ? null : sha256(files.policy),
    }
    const digest = yield* hash({ schemaVersion: 'bayn.live-graduation-evidence-digest.v1', files: fileHashes })
    return {
      schemaVersion: 'bayn.live-graduation-verdict.v1' as const,
      verdict,
      evidenceDigestSha256: digest,
      fileHashes,
      minimumMode,
      latestCompletedSession: latest?.date ?? null,
      sip,
      sleeves: checks.map((check) => ({ ...check, verdict: combine([portfolio.verdict, check.verdict]) })),
      portfolio: { ...portfolio.report(), ...combinedMetrics, verdict },
    }
  })

type Report = Result.Result.Success<ReturnType<typeof evaluateLiveGraduation>>

export const renderGraduationMarkdown = (report: Report) => {
  const describe = (findings: readonly Finding[]) =>
    findings.map(
      ({ code, date, detail }) =>
        `- ${date === undefined ? '' : `${date}: `}${code}${detail === undefined ? '' : ` — ${detail}`}`,
    )
  const economicsText = (metrics: Report['portfolio'] | Report['sleeves'][number]) => [
    `- Net realized P&L (USD micros): ${metrics.netRealizedMicros ?? 'unavailable'}`,
    `- Realized max drawdown (fraction): ${metrics.maxRealizedDrawdown ?? 'unavailable'}; research p95 limit: ${metrics.limit?.fraction ?? 'unavailable'}`,
  ]
  return [
    `# Bayn paper-to-live graduation: ${report.verdict}`,
    '',
    'Evidence review only. This verdict grants no authority to trade or allocate capital.',
    '',
    `- Evidence SHA-256: \`${report.evidenceDigestSha256}\``,
    `- Session minimums: ${report.minimumMode}; latest completed session: ${report.latestCompletedSession ?? 'unavailable'}`,
    `- Market data: ${report.sip}`,
    '',
    '## Portfolio',
    ...economicsText(report.portfolio),
    ...describe([...report.portfolio.blockers, ...report.portfolio.gaps]),
    ...report.sleeves.flatMap((sleeve) => [
      '',
      `## ${sleeve.sleeve} — ${sleeve.verdict}`,
      `- Clean completed sessions: ${sleeve.cleanCompletedSessions}/${sleeve.registeredCompletedSessions}; minimum: ${sleeve.minimumCompletedSessions}`,
      ...economicsText(sleeve),
      ...(sleeve.slippage === null
        ? []
        : [
            `- Realized slippage (bp): mean ${sleeve.slippage.meanBps ?? 'unavailable'}, median ${sleeve.slippage.medianBps ?? 'unavailable'} over ${sleeve.slippage.samples} round trips (both must be < ${sleeve.slippage.limitBps})`,
          ]),
      ...describe([...sleeve.blockers, ...sleeve.gaps]),
    ]),
  ].join('\n')
}
