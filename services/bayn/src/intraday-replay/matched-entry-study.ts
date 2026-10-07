import { Effect, Result, Schema } from 'effect'
import type { MarketCalendarObservation, MarketCalendarSession } from '../broker/alpaca/model'

import { canonicalHashV1Result } from '../hash'
import { JevPurpose } from '../jev/portfolio'
import { intradayInstantNanos } from '../market-data/intraday/time'
import { observedQuoteAt } from '../market-data/streaming/projection'
import { constructSimulatedSnapshot, type StrategyMarketSnapshot } from '../market-data/streaming/snapshot'
import {
  IsoDateSchema,
  NonNegativeIntegerSchema,
  Sha256Schema,
  SourceRevisionSchema,
  UnsignedMicrosSchema,
  UtcInstantSchema,
  StrictNonEmptyStringSchema,
  strictParseOptions,
} from '../schemas'
import {
  createMatchedLifecycle,
  finishMatchedLifecycle,
  MatchedEvent,
  stepMatchedLifecycle,
  type MatchedLifecycle,
  type MatchedTerms,
} from './matched-entry-lifecycle'
import { prepareSignalStudyBatch, SignalScreenRule, SignalStudyFailure, SignalStudyInputSchema } from './signal-study'
import { openBacktestSource, type BacktestSourceManifest, type BacktestSourceReceipt } from './source'

export enum MatchedDataRole {
  Development = 'DEVELOPMENT',
  Prospective = 'PROSPECTIVE',
}
export enum MatchedRecommendation {
  Inconclusive = 'INCONCLUSIVE',
  DevelopmentOnly = 'DEVELOPMENT_ONLY',
  Stop = 'STOP_JEV_ENTRY_HYPOTHESIS',
  TestPortfolio = 'TEST_FROZEN_PORTFOLIO',
}

export const matchedEntryDefinition = {
  schemaVersion: 'bayn.matched-entry-definition.v1',
  sessions: 5,
  minimumDifferentSelections: 20,
  budgetMicros: '10000000000',
  pollIntervalMs: 5000,
  rules: [SignalScreenRule.Jev, SignalScreenRule.RelativeMomentum],
  lifecycle:
    'One IOC entry; same whole-share budget, quotes, routing, fees, 50 bp stop, 15 minute maximum hold, five-minute close window and persistent reducing IOC retries. No model management.',
  comparison:
    'Per-opportunity net micro-USD divided by the fixed budget. Include abstentions and unfilled entries as zero execution P&L; unknown model answers and unresolved lifecycles are missing, never zero.',
  costs:
    'Every batch pays its witnessed entry-inference cost on JEV including abstentions. Shared allocated operating cost is charged equally per opportunity. Stress adds ten bps per filled leg.',
  falsification:
    'With complete prospective evidence and at least twenty different selections, nonpositive Jev net budget return or paired increment in either base or ten-bp stress stops this entry hypothesis. Positive results only justify the separate frozen portfolio acceptance test.',
  limitations: [
    'Overlapping opportunity labels are not a portfolio, frequency, capacity estimate or economic qualification.',
    'Naturally retained flat-entry batches are endogenous to the current strategy. Missing opportunities while holding are outside the estimand.',
    'Historical sessions are development, even when the screen is complete. Five future sessions cannot prove profitability.',
    'Supplied arrival times, source inventory, latency calibration, quote size/capacity, tariffs and allocated operating costs require independent retained witnesses.',
    'No order placement, paid inference, strategy promotion, risk change or capital authority.',
  ],
} as const

export const MatchedRegistrationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.matched-entry-registration.v1'),
  definitionHash: Sha256Schema,
  sourceRevision: SourceRevisionSchema,
  protocolHash: Sha256Schema,
  registeredAt: UtcInstantSchema,
  dataRole: Schema.Enum(MatchedDataRole),
  sessionDates: Schema.Array(IsoDateSchema).check(Schema.isMinLength(5), Schema.isMaxLength(5)),
  latencyMs: NonNegativeIntegerSchema.check(Schema.isLessThanOrEqualTo(60_000)),
  executionAssumptionsHash: Sha256Schema,
  latencyEvidenceHash: Schema.NullOr(Sha256Schema),
  capacityEvidenceHash: Schema.NullOr(Sha256Schema),
})
const WitnessedCost = Schema.NullOr(
  Schema.Struct({
    costMicros: UnsignedMicrosSchema,
    evidenceHash: Sha256Schema,
    unresolvedCount: NonNegativeIntegerSchema,
  }),
)
export const MatchedStudyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.matched-entry-input.v1'),
  witnesses: Schema.Array(Schema.Struct({ sha256: Sha256Schema, path: StrictNonEmptyStringSchema })),
  study: SignalStudyInputSchema,
  inventory: Schema.Array(
    Schema.Struct({
      sessionDate: IsoDateSchema,
      entryBatchIds: Schema.Array(Sha256Schema),
      evidenceHash: Schema.NullOr(Sha256Schema),
    }),
  ),
  costs: Schema.Array(
    Schema.Struct({
      batchId: Sha256Schema,
      inference: WitnessedCost,
      sharedOperating: WitnessedCost,
    }),
  ),
})
export type MatchedRegistration = typeof MatchedRegistrationSchema.Type

export const matchedCalendarSessions = (
  registration: MatchedRegistration,
  calendars: readonly MarketCalendarObservation[],
) =>
  Result.gen(function* () {
    const dates = registration.sessionDates
    const first = dates[0]
    const last = dates.at(-1)
    if (
      dates.length !== 5 ||
      first === undefined ||
      last === undefined ||
      new Set(dates).size !== 5 ||
      dates.join(',') !== [...dates].sort().join(',')
    )
      return yield* Result.fail(
        new SignalStudyFailure({ message: 'Registered sessions must be five unique ordered dates' }),
      )
    const sessions = new Map<string, MarketCalendarSession>()
    for (const calendar of calendars) {
      for (const session of calendar.sessions) {
        if (session.date < first || session.date > last) continue
        const existing = sessions.get(session.date)
        if (existing !== undefined && (existing.openAt !== session.openAt || existing.closeAt !== session.closeAt))
          return yield* Result.fail(new SignalStudyFailure({ message: 'Retained calendars disagree on session hours' }))
        sessions.set(session.date, session)
      }
    }
    const scheduled = [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date))
    for (const calendar of calendars) {
      const present = new Set(calendar.sessions.map((session) => session.date))
      if (
        scheduled.some(
          (session) =>
            session.date >= calendar.requestedRange.start &&
            session.date <= calendar.requestedRange.end &&
            !present.has(session.date),
        )
      )
        return yield* Result.fail(
          new SignalStudyFailure({ message: 'Retained calendars disagree on session presence' }),
        )
    }
    // Continuous query coverage proves that intervening dates are closed, rather than unobserved.
    let coveredUntilMs = Date.parse(first)
    for (const range of calendars
      .map((calendar) => calendar.requestedRange)
      .sort((a, b) => a.start.localeCompare(b.start))) {
      if (Date.parse(range.start) > coveredUntilMs) break
      coveredUntilMs = Math.max(coveredUntilMs, Date.parse(range.end) + 86_400_000)
    }
    if (coveredUntilMs <= Date.parse(last))
      return yield* Result.fail(
        new SignalStudyFailure({ message: 'Retained calendars do not cover the registered date range' }),
      )
    if (scheduled.map((s) => s.date).join(',') !== dates.join(','))
      return yield* Result.fail(
        new SignalStudyFailure({ message: 'Registration is not five consecutive retained calendar sessions' }),
      )
    if (
      registration.dataRole === MatchedDataRole.Prospective &&
      Date.parse(registration.registeredAt) >= Date.parse(scheduled[0]?.openAt ?? '')
    )
      return yield* Result.fail(
        new SignalStudyFailure({ message: 'Prospective registration must precede the first session open' }),
      )
    return scheduled
  })

type Outcome = ReturnType<typeof finishMatchedLifecycle>
export interface MatchedPair {
  readonly batchId: string
  readonly sessionDate: string
  readonly jevSymbol: string | null
  readonly momentumSymbol: string | null
  readonly modelAvailable: boolean
  readonly jev: Outcome | null
  readonly momentum: Outcome | null
  readonly inferenceCostMicros: string | null
  readonly sharedOperatingCostMicros: string | null
}

const stress = (outcome: Outcome | null) =>
  outcome === null
    ? 0n
    : outcome.fills.reduce((sum, fill) => sum + (BigInt(fill.notionalMicros) * 10n + 9999n) / 10_000n, 0n)
const executionPnl = (symbol: string | null, outcome: Outcome | null) =>
  symbol === null ? 0n : outcome?.netExecutionPnlMicros == null ? null : BigInt(outcome.netExecutionPnlMicros)

export const summarizeMatchedPairs = (
  registration: MatchedRegistration,
  pairs: readonly MatchedPair[],
  completenessProblems: readonly string[],
) => {
  const problems = [...completenessProblems]
  if (registration.latencyEvidenceHash === null) problems.push('missing-latency-calibration')
  if (registration.capacityEvidenceHash === null) problems.push('missing-capacity-calibration')
  if (pairs.length === 0) problems.push('no-entry-observations')
  const paired = pairs.map((pair) => {
    const jevExecution = executionPnl(pair.jevSymbol, pair.jev)
    const momentumExecution = executionPnl(pair.momentumSymbol, pair.momentum)
    const complete =
      pair.modelAvailable &&
      jevExecution !== null &&
      momentumExecution !== null &&
      pair.inferenceCostMicros !== null &&
      pair.sharedOperatingCostMicros !== null
    if (!complete) problems.push(`incomplete-pair:${pair.batchId}`)
    const jev =
      complete && jevExecution !== null
        ? jevExecution - BigInt(pair.inferenceCostMicros ?? '0') - BigInt(pair.sharedOperatingCostMicros ?? '0')
        : null
    const momentum =
      complete && momentumExecution !== null ? momentumExecution - BigInt(pair.sharedOperatingCostMicros ?? '0') : null
    return {
      batchId: pair.batchId,
      jevNetMicros: jev === null ? null : String(jev),
      momentumNetMicros: momentum === null ? null : String(momentum),
      incrementalMicros: jev === null || momentum === null ? null : String(jev - momentum),
      stressedJevNetMicros: jev === null ? null : String(jev - stress(pair.jev)),
      stressedIncrementalMicros:
        jev === null || momentum === null ? null : String(jev - momentum - stress(pair.jev) + stress(pair.momentum)),
    }
  })
  const differentSelections = pairs.filter((p) => p.modelAvailable && p.jevSymbol !== p.momentumSymbol).length
  if (differentSelections < matchedEntryDefinition.minimumDifferentSelections)
    problems.push('insufficient-different-selections')
  const complete = problems.length === 0
  const mean = (field: 'jevNetMicros' | 'incrementalMicros' | 'stressedJevNetMicros' | 'stressedIncrementalMicros') =>
    !complete
      ? null
      : (Number(paired.reduce((sum, pair) => sum + BigInt(pair[field] ?? '0'), 0n)) /
          pairs.length /
          Number(matchedEntryDefinition.budgetMicros)) *
        10_000
  const means = {
    jevNetBudgetReturnBps: mean('jevNetMicros'),
    incrementalBudgetReturnBps: mean('incrementalMicros'),
    stressedJevNetBudgetReturnBps: mean('stressedJevNetMicros'),
    stressedIncrementalBudgetReturnBps: mean('stressedIncrementalMicros'),
  }
  return {
    completion: complete ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
    recommendation: !complete
      ? MatchedRecommendation.Inconclusive
      : registration.dataRole === MatchedDataRole.Development
        ? MatchedRecommendation.DevelopmentOnly
        : Object.values(means).some((value) => value !== null && value <= 0)
          ? MatchedRecommendation.Stop
          : MatchedRecommendation.TestPortfolio,
    differentSelections,
    opportunityCount: pairs.length,
    completenessProblems: [...new Set(problems)],
    means,
    paired,
  }
}

// Native receipt sequencing differs from a capture cursor. Compare exact selected market payloads
// and feature source coordinates, while preserving native provenance in the original observation.
export const matchedObservationMaterial = (snapshot: StrategyMarketSnapshot) => ({
  bars: snapshot.bars.map((row) => ({
    ...row,
    eventAt: String(intradayInstantNanos(row.eventAt)),
    ingestedAt: String(intradayInstantNanos(row.ingestedAt)),
  })),
  quotes: snapshot.quotes.map((row) => ({
    ...row,
    eventAt: String(intradayInstantNanos(row.eventAt)),
    ingestedAt: String(intradayInstantNanos(row.ingestedAt)),
  })),
  trades: snapshot.trades.map((row) => ({
    ...row,
    eventAt: String(intradayInstantNanos(row.eventAt)),
    ingestedAt: String(intradayInstantNanos(row.ingestedAt)),
  })),
  symbols: snapshot.manifest.symbols,
  exclusions: snapshot.manifest.candidateExclusions ?? [],
  features: snapshot.manifest.streaming.features.map(({ topic, partition, offset, value }) => ({
    topic,
    partition,
    offset,
    value,
  })),
})

export const matchedSourceCompletenessProblems = (source: BacktestSourceManifest): string[] => {
  const problems: string[] = []
  if (source.transport !== 'captured-kafka' && source.transport !== 'original-capture')
    problems.push('original-stream-arrivals-not-observed')
  if ((source.archiveUnobservedPartitions?.length ?? 0) > 0) problems.push('unobserved-source-partitions')
  return problems
}

export const runMatchedEntryStudy = (
  raw: unknown,
  registered: unknown,
  arrivalsPath: string,
  receipt: BacktestSourceReceipt,
) =>
  Effect.gen(function* () {
    const registration = yield* Schema.decodeUnknownEffect(MatchedRegistrationSchema, strictParseOptions)(registered)
    const input = yield* Schema.decodeUnknownEffect(MatchedStudyInputSchema, strictParseOptions)(raw)
    const definitionHash = yield* Effect.fromResult(canonicalHashV1Result(matchedEntryDefinition))
    if (
      registration.executionAssumptionsHash !==
      (yield* Effect.fromResult(canonicalHashV1Result(input.study.assumptions)))
    )
      return yield* new SignalStudyFailure({ message: 'Execution assumptions differ from registration' })
    const witnessed = new Set(input.witnesses.map((w) => w.sha256))
    const required = [
      registration.latencyEvidenceHash,
      registration.capacityEvidenceHash,
      ...input.inventory.map((i) => i.evidenceHash),
      ...input.costs.flatMap((c) => [c.inference?.evidenceHash ?? null, c.sharedOperating?.evidenceHash ?? null]),
    ]
    if (required.some((hash) => hash !== null && !witnessed.has(hash)))
      return yield* new SignalStudyFailure({ message: 'Referenced private witness is missing from input' })
    if (registration.definitionHash !== definitionHash || registration.latencyMs !== input.study.assumptions.latencyMs)
      return yield* new SignalStudyFailure({ message: 'Frozen definition or routing assumptions differ' })
    const dates = registration.sessionDates
    const sourceHash = yield* Effect.fromResult(canonicalHashV1Result(input.study.source))
    const batches = yield* Effect.forEach(input.study.batches, (b) => Effect.fromResult(prepareSignalStudyBatch(b)))
    const problems = matchedSourceCompletenessProblems(input.study.source)
    const ids = new Set<string>()
    for (const batch of batches) {
      const manifest = batch.snapshot.manifest
      if (ids.has(batch.plan.batchId)) return yield* new SignalStudyFailure({ message: 'Duplicate retained batch' })
      ids.add(batch.plan.batchId)
      if (registration.protocolHash !== (yield* Effect.fromResult(canonicalHashV1Result(batch.observation.protocol))))
        return yield* new SignalStudyFailure({ message: 'Retained protocol differs from registration' })
      const protocol = batch.observation.protocol
      if (
        protocol.maximumHoldingMinutes !== 15 ||
        protocol.protectiveStopBps !== 50 ||
        protocol.flattenBeforeCloseMinutes !== 5
      )
        return yield* new SignalStudyFailure({ message: 'Matched lifecycle requires the frozen protective protocol' })
      if (!dates.includes(manifest.sessionDate))
        return yield* new SignalStudyFailure({ message: 'Observation outside registered sessions' })
      if (
        manifest.schemaVersion === 'bayn.simulated-market-snapshot.v1' &&
        (manifest.streaming.runId !== input.study.runId || manifest.streaming.sourceManifestHash !== sourceHash)
      )
        return yield* new SignalStudyFailure({ message: 'Observation belongs to another source or run' })
    }
    const scheduled = yield* Effect.fromResult(
      matchedCalendarSessions(
        registration,
        batches.map((batch) => batch.snapshot.manifest.calendar),
      ),
    )
    const inventories = new Set<string>()
    const entries = batches.filter((b) => b.observation.portfolio.purpose === JevPurpose.Entry)
    for (const inventory of input.inventory) {
      if (
        inventories.has(inventory.sessionDate) ||
        !dates.includes(inventory.sessionDate) ||
        new Set(inventory.entryBatchIds).size !== inventory.entryBatchIds.length
      )
        return yield* new SignalStudyFailure({ message: 'Invalid or duplicated batch inventory' })
      inventories.add(inventory.sessionDate)
      const actual = entries
        .filter((b) => b.snapshot.manifest.sessionDate === inventory.sessionDate)
        .map((b) => b.plan.batchId)
        .sort()
      if (actual.join(',') !== [...inventory.entryBatchIds].sort().join(','))
        problems.push(`entry-inventory-mismatch:${inventory.sessionDate}`)
      if (inventory.evidenceHash === null) problems.push(`missing-inventory-witness:${inventory.sessionDate}`)
    }
    for (const session of scheduled) {
      if (!inventories.has(session.date)) problems.push(`missing-session-inventory:${session.date}`)
      if (
        input.study.source.coverageStartMs > Date.parse(session.openAt) ||
        input.study.source.coverageEndMs < Date.parse(session.closeAt)
      )
        problems.push(`source-does-not-cover-session:${session.date}`)
    }
    const costs = new Map<string, (typeof input.costs)[number]>()
    for (const cost of input.costs) {
      if (costs.has(cost.batchId) || !entries.some((b) => b.plan.batchId === cost.batchId))
        return yield* new SignalStudyFailure({ message: 'Duplicate or unmatched batch costs' })
      costs.set(cost.batchId, cost)
    }
    const source = yield* openBacktestSource(arrivalsPath, input.study.source, input.study.runId, receipt)
    const tasks: { atMs: number; run: Effect.Effect<void, SignalStudyFailure> }[] = []
    const results = new Map<string, Map<string, MatchedLifecycle>>()
    const add = (atMs: number, run: Effect.Effect<void, SignalStudyFailure>) => {
      if (atMs > input.study.source.coverageEndMs) return
      tasks.push({ atMs, run })
    }
    for (const batch of entries) {
      const manifest = batch.snapshot.manifest
      add(
        Date.parse(batch.observation.observedAt),
        Effect.gen(function* () {
          const reproduced = yield* Effect.fromResult(
            constructSimulatedSnapshot(yield* source.cursor, source.source, {
              ...manifest,
              universe: batch.observation.protocol.universe,
            }),
          )
          const expected = yield* Effect.fromResult(canonicalHashV1Result(matchedObservationMaterial(batch.snapshot)))
          const actual = yield* Effect.fromResult(canonicalHashV1Result(matchedObservationMaterial(reproduced)))
          if (expected !== actual)
            return yield* new SignalStudyFailure({
              message: 'Frozen arrivals do not reproduce retained market material',
            })
        }).pipe(
          Effect.mapError((cause) => new SignalStudyFailure({ message: 'Matched source reproduction failed', cause })),
        ),
      )
      const session = scheduled.find((s) => s.date === manifest.sessionDate)
      if (session === undefined) return yield* new SignalStudyFailure({ message: 'Missing matched session' })
      const states = new Map<string, MatchedLifecycle>()
      results.set(batch.plan.batchId, states)
      const symbols = new Set([batch.selected[SignalScreenRule.Jev], batch.selected[SignalScreenRule.RelativeMomentum]])
      for (const symbol of symbols) {
        if (symbol === null) continue
        states.set(symbol, yield* Effect.fromResult(createMatchedLifecycle(matchedEntryDefinition.budgetMicros)))
        const terms: MatchedTerms = {
          symbol,
          protocol: batch.observation.protocol,
          assumptions: input.study.assumptions,
          entryBudgetMicros: matchedEntryDefinition.budgetMicros,
          decidedAtMs: Date.parse(batch.decidedAt),
          cutoffMs: Date.parse(session.closeAt) - 5 * 60_000,
          closeMs: Date.parse(session.closeAt),
        }
        const event = (kind: MatchedEvent, atMs: number) =>
          add(
            atMs,
            Effect.gen(function* () {
              const state = states.get(symbol)
              if (state === undefined)
                return yield* new SignalStudyFailure({ message: 'Missing matched lifecycle state' })
              if (kind === MatchedEvent.Poll && state.exit !== null) return
              // Each poll has a possible arrival task; only an actual pending route may consume it.
              if (
                kind === MatchedEvent.ExitArrival &&
                (state.exit === null || state.exit.atMs + registration.latencyMs !== atMs)
              )
                return
              states.set(
                symbol,
                yield* Effect.fromResult(
                  stepMatchedLifecycle(state, terms, {
                    kind,
                    atMs,
                    quote: observedQuoteAt((yield* source.cursor).projection, symbol, atMs),
                  }),
                ),
              )
            }).pipe(Effect.mapError((cause) => new SignalStudyFailure({ message: 'Matched lifecycle failed', cause }))),
          )
        event(MatchedEvent.EntryDecision, terms.decidedAtMs)
        const entryAt = terms.decidedAtMs + registration.latencyMs
        event(MatchedEvent.EntryArrival, entryAt)
        for (
          let at = entryAt + matchedEntryDefinition.pollIntervalMs;
          at + registration.latencyMs < terms.closeMs;
          at += matchedEntryDefinition.pollIntervalMs
        ) {
          event(MatchedEvent.Poll, at)
          event(MatchedEvent.ExitArrival, at + registration.latencyMs)
        }
      }
    }
    tasks.sort((a, b) => a.atMs - b.atMs)
    for (const task of tasks) {
      yield* source.advanceTo(task.atMs)
      yield* task.run
    }
    yield* source.finish
    const pairs: MatchedPair[] = entries.map((batch) => {
      const states = results.get(batch.plan.batchId)
      const jevSymbol = batch.selected[SignalScreenRule.Jev]
      const momentumSymbol = batch.selected[SignalScreenRule.RelativeMomentum]
      const finish = (symbol: string | null) => {
        const state = symbol === null ? undefined : states?.get(symbol)
        return state === undefined ? null : finishMatchedLifecycle(state)
      }
      const cost = costs.get(batch.plan.batchId)
      return {
        batchId: batch.plan.batchId,
        sessionDate: batch.snapshot.manifest.sessionDate,
        jevSymbol,
        momentumSymbol,
        modelAvailable: batch.modelStatus === 'AVAILABLE',
        jev: finish(jevSymbol),
        momentum: finish(momentumSymbol),
        inferenceCostMicros: cost?.inference?.unresolvedCount === 0 ? cost.inference.costMicros : null,
        sharedOperatingCostMicros:
          cost?.sharedOperating?.unresolvedCount === 0 ? cost.sharedOperating.costMicros : null,
      }
    })
    const report = {
      schemaVersion: 'bayn.matched-entry-study.v1',
      definition: matchedEntryDefinition,
      definitionHash,
      registration,
      registrationHash: yield* Effect.fromResult(canonicalHashV1Result(registration)),
      inputHash: yield* Effect.fromResult(canonicalHashV1Result(input)),
      sourceReceiptHash: receipt.contentHash,
      sourceManifestHash: sourceHash,
      sourceRecordCount: input.study.source.recordCount,
      observations: entries.map((b) => ({
        batchId: b.plan.batchId,
        observedAt: b.observation.observedAt,
        decidedAt: b.decidedAt,
        modelStatus: b.modelStatus,
        selected: b.selected,
        exclusions: b.plan.candidates.filter((c) => c.status === 'EXCLUDED'),
      })),
      pairs,
      summary: summarizeMatchedPairs(registration, pairs, problems),
    }
    return { ...report, reportHash: yield* Effect.fromResult(canonicalHashV1Result(report)) }
  })
