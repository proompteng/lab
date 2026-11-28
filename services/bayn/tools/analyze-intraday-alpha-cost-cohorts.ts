import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { Schema } from 'effect'

import { IsoDateSchema, Sha256Schema, SymbolSchema, UtcInstantSchema } from '../src/schemas'
import { IntradayAlphaPhase } from '../src/strategy/intraday-alpha/constants'

const phases = [
  IntradayAlphaPhase.MorningOrb,
  IntradayAlphaPhase.MiddayReversion,
  IntradayAlphaPhase.NoiseAreaTrend,
] as const
const PhaseSchema = Schema.Literals(phases)
const CountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveSchema = Schema.Finite.check(Schema.isGreaterThan(0))
const UniqueSymbolsSchema = Schema.Array(SymbolSchema).check(Schema.isUnique())
const TradeSchema = Schema.Struct({
  sessionDate: IsoDateSchema,
  phase: PhaseSchema,
  symbol: SymbolSchema,
  direction: Schema.Literals(['LONG', 'SHORT']),
  shares: Schema.Int.check(Schema.isGreaterThan(0)),
  entryPrice: PositiveSchema,
  exitPrice: PositiveSchema,
  entryAt: UtcInstantSchema,
  exitAt: UtcInstantSchema,
  exitReason: Schema.Literals(['STOP', 'TARGET', 'MAX_HOLD', 'EOD']),
  grossPnlUsd: Schema.Finite,
  netPnlUsd: Schema.Finite,
})
const DaySchema = Schema.Struct({
  date: IsoDateSchema,
  baselineAvailable: Schema.Boolean,
  benchmarkAvailable: Schema.Boolean,
  expectedRegularMinutes: CountSchema,
  benchmarkMinutes: CountSchema,
  requiredBenchmarkCheckpoints: CountSchema,
  unavailableBenchmarkCheckpoints: Schema.Array(
    Schema.Struct({ phase: PhaseSchema, observedAt: UtcInstantSchema, expectedBarAt: UtcInstantSchema }),
  ),
  missingConcurrentMarkWindows: CountSchema,
  trades: Schema.Array(TradeSchema),
  unresolvedExits: Schema.Array(
    Schema.Struct({
      symbol: SymbolSchema,
      entryAt: UtcInstantSchema,
      exitDueAt: UtcInstantSchema,
      reason: Schema.Literal('POST_DEADLINE_PRICE_UNAVAILABLE'),
    }),
  ),
  attempts: Schema.Array(
    Schema.Struct({
      phase: PhaseSchema,
      observedAt: UtcInstantSchema,
      orderExpiresAt: UtcInstantSchema,
      occupiedSymbols: UniqueSymbolsSchema,
      selectedSymbols: UniqueSymbolsSchema,
      filledSymbols: UniqueSymbolsSchema,
    }),
  ),
})
const ScenarioSchema = Schema.Struct({
  slippageBps: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  totalSessions: CountSchema,
  evaluatedSessions: CountSchema,
  unavailableSessions: CountSchema,
  completeOutcomes: Schema.Boolean,
  totalTrades: CountSchema,
  modeledFilledLegs: CountSchema,
  modeledClosedNet: Schema.Finite,
  totalNet: Schema.NullOr(Schema.Finite),
  sessionDetails: Schema.Array(DaySchema),
})
const ReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.intraday-alpha-bar-scenario.v2'),
  qualification: Schema.Literal('UNQUALIFIED'),
  evidenceClass: Schema.Literal('RETROSPECTIVE_EVENT_TIME_BAR_SCENARIO'),
  policySchemaVersion: Schema.Literal('bayn.intraday-alpha-policy.v2'),
  policyHash: Sha256Schema,
  calendarHash: Sha256Schema,
  sources: Schema.Array(Schema.Struct({ path: Schema.String, sha256: Sha256Schema, bytes: CountSchema })),
  partialBaselineScenario: Schema.Boolean,
  baselineCoverage: Schema.Struct({
    classification: Schema.Literals(['PARTIAL_SUPPLIED_BASELINE_SCENARIO', 'SUPPLIED_BAR_BASELINE_SCENARIO']),
    evaluationSessionsWithoutBaseline: CountSchema,
    evaluationSessionsWithPartialBaseline: CountSchema,
    missingBaselineSessionsBySymbol: Schema.Record(SymbolSchema, CountSchema),
    adjustedDailySupplementSupplied: Schema.Boolean,
  }),
  assumptions: Schema.Struct({ modeledSellFeeBps: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)) }),
  sessions: Schema.Array(IsoDateSchema).check(Schema.isMinLength(1), Schema.isUnique()),
  results: Schema.Array(ScenarioSchema).check(Schema.isMinLength(2)),
})

type Trade = typeof TradeSchema.Type
type Day = typeof DaySchema.Type

const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const total = (values: readonly number[]): number => {
  const result = values.reduce((sum, value) => sum + value, 0)
  if (!Number.isFinite(result)) throw new Error('Diagnostic total is not finite')
  return result
}
const equalMoney = (left: number, right: number): boolean =>
  Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= Math.max(1e-7, Math.abs(right) * 1e-10)

// Cost changes can alter executable quantity and prices. Those are outcomes, not join keys.
const tradeKey = (trade: Trade): string =>
  JSON.stringify([trade.sessionDate, trade.phase, trade.symbol, trade.direction, trade.entryAt])
const observationsAvailable = (day: Day): boolean =>
  day.baselineAvailable && day.benchmarkAvailable && day.missingConcurrentMarkWindows === 0
const dayComplete = (day: Day): boolean => observationsAvailable(day) && day.unresolvedExits.length === 0
const summarize = (trades: readonly Trade[]) => ({
  entries: trades.length,
  grossPnlAfterModeledSlippage: total(trades.map((trade) => trade.grossPnlUsd)),
  modeledSellFees: total(trades.map((trade) => trade.grossPnlUsd - trade.netPnlUsd)),
  modeledClosedNet: total(trades.map((trade) => trade.netPnlUsd)),
  entryNotional: total(trades.map((trade) => trade.shares * trade.entryPrice)),
})
const fingerprint = (keys: readonly string[]) => hash(JSON.stringify([...keys].sort()))

/** Describes an existing scenario; never selects parameters or repairs unavailable outcomes. */
export const analyzeIntradayAlphaCostCohorts = (reportText: string) => {
  const report = Schema.decodeUnknownSync(ReportSchema)(JSON.parse(reportText))
  if (report.sessions.some((date, index) => index > 0 && date <= (report.sessions[index - 1] ?? ''))) {
    throw new Error('The retained calendar must be strictly chronological')
  }
  const scenarios = [...report.results].sort((a, b) => a.slippageBps - b.slippageBps)
  if (new Set(scenarios.map((scenario) => scenario.slippageBps)).size !== scenarios.length) {
    throw new Error('Cost scenarios must be unique')
  }

  const cohorts = scenarios.map((scenario) => {
    if (
      scenario.totalSessions !== report.sessions.length ||
      scenario.sessionDetails.length !== report.sessions.length ||
      scenario.sessionDetails.some((day, index) => day.date !== report.sessions[index])
    ) {
      throw new Error('Every scenario must retain every calendar session exactly once in order')
    }
    const trades = new Map<string, Trade>()
    for (const day of scenario.sessionDetails) {
      if (
        day.benchmarkAvailable !== (day.benchmarkMinutes > 0 && day.unavailableBenchmarkCheckpoints.length === 0) ||
        day.requiredBenchmarkCheckpoints < day.unavailableBenchmarkCheckpoints.length
      ) {
        throw new Error('Benchmark readiness differs from retained checkpoint evidence')
      }
      for (const trade of day.trades) {
        const key = tradeKey(trade)
        if (trades.has(key)) throw new Error('Duplicate trade identity would collide in a cost-cohort join')
        if (
          trade.sessionDate !== day.date ||
          !trade.entryAt.startsWith(day.date) ||
          !trade.exitAt.startsWith(day.date) ||
          trade.exitAt < trade.entryAt
        ) {
          throw new Error('Trade timestamps differ from their calendar session')
        }
        const gross = trade.shares * (trade.exitPrice - trade.entryPrice) * (trade.direction === 'LONG' ? 1 : -1)
        const sellNotional = trade.shares * (trade.direction === 'SHORT' ? trade.entryPrice : trade.exitPrice)
        if (
          !equalMoney(trade.grossPnlUsd, gross) ||
          !equalMoney(trade.netPnlUsd, gross - (sellNotional * report.assumptions.modeledSellFeeBps) / 10_000)
        ) {
          throw new Error('Trade economics do not reproduce the reported price, quantity and modeled sell fee')
        }
        trades.set(key, trade)
      }

      // Bind every closed or unresolved leg to exactly one committed fill window, including true zero-fill attempts.
      const outcomes = [...day.trades, ...day.unresolvedExits]
      const used = new Set<number>()
      for (const attempt of day.attempts) {
        if (
          attempt.orderExpiresAt <= attempt.observedAt ||
          attempt.filledSymbols.some((symbol) => !attempt.selectedSymbols.includes(symbol))
        ) {
          throw new Error('Invalid committed attempt or filled-symbol membership')
        }
        for (const symbol of attempt.filledSymbols) {
          const matching = outcomes
            .map((outcome, index) => ({ outcome, index }))
            .filter(
              ({ outcome }) =>
                outcome.symbol === symbol &&
                outcome.entryAt > attempt.observedAt &&
                outcome.entryAt <= attempt.orderExpiresAt &&
                (!('phase' in outcome) || outcome.phase === attempt.phase),
            )
          const match = matching[0]
          if (matching.length !== 1 || match === undefined || used.has(match.index)) {
            throw new Error('A filled leg lacks a unique closed or unresolved outcome')
          }
          used.add(match.index)
        }
      }
      if (used.size !== outcomes.length) throw new Error('An outcome lacks a committed filled-leg source')
    }

    const unavailable = scenario.sessionDetails.filter((day) => !observationsAvailable(day)).length
    const complete = scenario.sessionDetails.every(dayComplete)
    const filled = total(
      scenario.sessionDetails.map((day) => total(day.attempts.map((attempt) => attempt.filledSymbols.length))),
    )
    const closed = total([...trades.values()].map((trade) => trade.netPnlUsd))
    if (
      scenario.unavailableSessions !== unavailable ||
      scenario.evaluatedSessions !== report.sessions.length - unavailable ||
      scenario.completeOutcomes !== complete ||
      scenario.totalTrades !== trades.size ||
      scenario.modeledFilledLegs !== filled ||
      !equalMoney(scenario.modeledClosedNet, closed) ||
      (complete ? scenario.totalNet === null || !equalMoney(scenario.totalNet, closed) : scenario.totalNet !== null)
    ) {
      throw new Error('Scenario counts, completeness or economics differ from the retained outcomes')
    }
    return { scenario, trades }
  })
  const first = cohorts[0]
  if (first === undefined) throw new Error('At least two scenarios are required')
  const commonKeys = [...first.trades.keys()].filter((key) => cohorts.every((cohort) => cohort.trades.has(key))).sort()
  const common = new Set(commonKeys)
  const sameExit = new Set(
    commonKeys.filter(
      (key) =>
        new Set(
          cohorts.map((cohort) => {
            const trade = cohort.trades.get(key)
            return JSON.stringify([trade?.exitAt, trade?.exitReason])
          }),
        ).size === 1,
    ),
  )
  const sameQuantityAndExit = new Set(
    commonKeys.filter(
      (key) => sameExit.has(key) && new Set(cohorts.map((cohort) => cohort.trades.get(key)?.shares)).size === 1,
    ),
  )

  const byPhase = phases.map((phase) => {
    const keys = commonKeys.filter((key) => first.trades.get(key)?.phase === phase)
    const rows = cohorts.map(({ scenario, trades }) => {
      const all = [...trades.values()].filter((trade) => trade.phase === phase)
      const matching = all.filter((trade) => common.has(tradeKey(trade)))
      const other = all.filter((trade) => !common.has(tradeKey(trade)))
      return {
        slippageBps: scenario.slippageBps,
        supportedClosed: summarize(all),
        commonEntries: summarize(matching),
        commonEntriesWithSameExit: summarize(matching.filter((trade) => sameExit.has(tradeKey(trade)))),
        commonEntriesWithSameQuantityAndExit: summarize(
          matching.filter((trade) => sameQuantityAndExit.has(tradeKey(trade))),
        ),
        scenarioSpecificEntries: summarize(other),
        scenarioSpecificIdentityHash: fingerprint(other.map(tradeKey)),
      }
    })
    const low = rows[0]
    const high = rows.at(-1)
    if (low === undefined || high === undefined) throw new Error('At least two scenarios are required')
    return {
      phase,
      commonEntryCount: keys.length,
      commonEntryIdentityHash: fingerprint(keys),
      sameExitClockAndReasonCount: keys.filter((key) => sameExit.has(key)).length,
      sameQuantityAndExitCount: keys.filter((key) => sameQuantityAndExit.has(key)).length,
      scenarios: rows,
      lowestToHighestCost: {
        fromSlippageBps: low.slippageBps,
        toSlippageBps: high.slippageBps,
        supportedClosedNetChange: high.supportedClosed.modeledClosedNet - low.supportedClosed.modeledClosedNet,
        commonEntryNetChange: high.commonEntries.modeledClosedNet - low.commonEntries.modeledClosedNet,
        membershipContributionChange:
          high.scenarioSpecificEntries.modeledClosedNet - low.scenarioSpecificEntries.modeledClosedNet,
      },
    }
  })

  return {
    schemaVersion: 'bayn.intraday-alpha-cost-cohorts.v1',
    qualification: 'UNQUALIFIED',
    evidenceScope: 'SUPPORTED_CLOSED_PATH_DIAGNOSTIC',
    inputReportSha256: hash(reportText),
    policySchemaVersion: report.policySchemaVersion,
    policyHash: report.policyHash,
    calendarHash: report.calendarHash,
    sources: report.sources.map((source) => ({ ...source, path: basename(source.path) })),
    partialBaselineScenario: report.partialBaselineScenario,
    baselineCoverage: report.baselineCoverage,
    tradeIdentityFields: ['sessionDate', 'phase', 'symbol', 'direction', 'entryAt'],
    identityExcludes: ['shares', 'entryPrice', 'exitPrice', 'exitAt', 'exitReason'],
    commonEntryCount: commonKeys.length,
    commonEntryIdentityHash: fingerprint(commonKeys),
    scenarioCoverage: cohorts.map(({ scenario }) => ({
      slippageBps: scenario.slippageBps,
      calendarSessions: scenario.totalSessions,
      evaluatedSessions: scenario.evaluatedSessions,
      unavailableSessions: scenario.unavailableSessions,
      completeOutcomes: scenario.completeOutcomes,
      completeWindowModeledNet: scenario.totalNet,
      supportedClosedTrades: scenario.totalTrades,
      unresolvedExits: total(scenario.sessionDetails.map((day) => day.unresolvedExits.length)),
    })),
    byPhase,
    calendarRows: report.sessions.map((date, index) => ({
      date,
      scenarios: cohorts.map(({ scenario }) => {
        const day = scenario.sessionDetails[index]
        if (day === undefined) throw new Error('Calendar session disappeared during cohort analysis')
        const closedNet = total(day.trades.map((trade) => trade.netPnlUsd))
        return {
          slippageBps: scenario.slippageBps,
          baselineAvailable: day.baselineAvailable,
          benchmarkAvailable: day.benchmarkAvailable,
          expectedRegularMinutes: day.expectedRegularMinutes,
          benchmarkMinutes: day.benchmarkMinutes,
          requiredBenchmarkCheckpoints: day.requiredBenchmarkCheckpoints,
          unavailableBenchmarkCheckpoints: day.unavailableBenchmarkCheckpoints,
          missingConcurrentMarkWindows: day.missingConcurrentMarkWindows,
          unresolvedExits: day.unresolvedExits.length,
          committedAttempts: day.attempts.length,
          unfilledAttempts: day.attempts.filter((attempt) => attempt.filledSymbols.length === 0).length,
          supportedClosedTrades: day.trades.length,
          commonEntries: day.trades.filter((trade) => common.has(tradeKey(trade))).length,
          modeledClosedNet: closedNet,
          completeDayModeledNet: dayComplete(day) ? closedNet : null,
        }
      }),
    })),
    limitations: [
      'The common-entry intersection conditions on modeled fill outcomes across cost scenarios; it is selected in sample, not a causal strategy comparison or an independent holdout.',
      'Changing cost scenarios can change fill membership, quantities and exits. Matched-entry contrasts are not pure cost effects unless the compared execution path is also held fixed.',
      'Every original calendar session and unavailable observation is retained. Closed subtotals do not replace an incomplete session or establish a complete-window return.',
      'This diagnostic inherits archival revision, arrival, synthetic quote, fill, borrow, baseline and account-model limitations from the source replay; it grants no qualification or trading authority.',
    ],
  }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined || process.argv.length !== 3) {
    throw new Error('Usage: bun tools/analyze-intraday-alpha-cost-cohorts.ts <full-replay-report.json>')
  }
  const result = {
    ...analyzeIntradayAlphaCostCohorts(readFileSync(path, 'utf8')),
    diagnosticSourceSha256: hash(readFileSync(new URL(import.meta.url), 'utf8')),
  }
  console.log(JSON.stringify(result, null, 2))
}
