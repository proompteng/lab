import { controlExitDefinition } from './control-portfolio'
import { cryptoTakerFeeSchedule } from '../strategy/execution-model/fees'
import { jevMarketForFeed } from '../jev/markets'
import { isContinuousMarket, observationSession, continuousExecutionPolicy, type MarketHours } from '../market-hours'
import { exchangeSessions } from '../market-hours'
import { Effect, FileSystem, Result, Schema } from 'effect'
import type { MarketCalendarSession } from '../broker/alpaca/model'

import { canonicalHashV1Result, sha256 } from '../hash'
import { EntryTimingReceiptSchema } from './entry-timing'
import { ExecutionDecisionDocumentSchema } from '../shadow-decision-contract'
import { JevPurpose } from '../jev/portfolio'
import { CycleState } from '../cycle/model'
import { verifyJevStudyInventory, type JevStudyInventory } from '../jev/study-inventory'
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
  schemaVersion: 'bayn.matched-entry-definition.v8',
  timing: 'bayn.jev-entry-timing.v2: explicit native millisecond clock; conservative post-COMMIT bucket upper bound.',
  cryptoFees: cryptoTakerFeeSchedule,
  inventory:
    'bayn.jev-study-inventory.v1: complete native cycle and batch cut, including management and pending results.',
  sourceComparison: 'bayn.matched-model-input-material.v2',
  sessions: 5,
  minimumDifferentSelections: 20,
  budgetMicros: '10000000000',
  pollIntervalMs: 5000,
  rules: ['JEV_FILTERED', 'DELAYED_MOMENTUM', 'IMMEDIATE_MOMENTUM'],
  lifecycle:
    'One IOC entry and persistent reducing IOC exits; same instrument-quantized budget, quotes, routing, fees, 50 bp price stop, 100 bp estimated execution-net profit target including adverse exit allowance, 15 minute maximum hold, five-minute equity close window; continuous markets retain elapsed holding deadlines across UTC dates. No model management.',
  comparison:
    'Immediate momentum starts at witnessed deterministic completion. Delayed momentum and Jev start at witnessed decision commitment. Selection is Jev minus delayed momentum; delay is delayed minus immediate; total is Jev minus immediate. Per-opportunity net micro-USD divided by the fixed budget. Include abstentions and unfilled entries as zero execution P&L; unknown model answers and unresolved lifecycles are missing, never zero.',
  costs:
    'Every batch pays its witnessed entry-inference cost on JEV including abstentions. Shared allocated operating cost is charged equally per opportunity. Stress adds ten bps per filled leg.',
  falsification:
    'With complete prospective evidence and at least twenty different selections, nonpositive Jev net budget return or total increment over immediate momentum in either base or ten-bp stress stops this entry hypothesis. Positive results only justify the separate frozen portfolio acceptance test.',
  limitations: [
    'Overlapping opportunity labels are not a portfolio, frequency, capacity estimate or economic qualification.',
    'Naturally retained flat-entry batches are endogenous to the current strategy. Missing opportunities while holding are outside the estimand.',
    'Historical sessions are development, even when the screen is complete. Five future sessions cannot prove profitability.',
    'Supplied arrival times, source inventory, latency calibration, quote size/capacity, tariffs and allocated operating costs require independent retained witnesses.',
    'No order placement, paid inference, strategy promotion, risk change or capital authority.',
  ],
} as const

export const MatchedRegistrationSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.matched-entry-registration.v2'),
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
export const MatchedEntryTimingSchema = Schema.Struct({
  inputAvailableAt: UtcInstantSchema,
  deterministicSelectedAt: UtcInstantSchema,
  batchCompletedAt: UtcInstantSchema,
  decisionCommittedAt: UtcInstantSchema,
  deterministicSymbol: Schema.NullOr(StrictNonEmptyStringSchema),
  evidenceHash: Sha256Schema,
  decisionEvidenceHash: Sha256Schema,
})

export enum MatchedArm {
  Jev = 'JEV_FILTERED',
  DelayedMomentum = 'DELAYED_MOMENTUM',
  ImmediateMomentum = 'IMMEDIATE_MOMENTUM',
}

export const MatchedStudyInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal('bayn.matched-entry-input.v2'),
  timings: Schema.Array(Schema.Struct({ batchId: Sha256Schema, witness: Schema.NullOr(MatchedEntryTimingSchema) })),
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

export const matchedCalendarSessions = (registration: MatchedRegistration, calendars: readonly MarketHours[]) =>
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
    if (calendars.some(isContinuousMarket)) {
      if (!calendars.every(isContinuousMarket))
        return yield* Result.fail(new SignalStudyFailure({ message: 'A frozen study must use one market schedule' }))
      const hours = calendars[0]
      if (hours === undefined) return yield* Result.fail(new SignalStudyFailure({ message: 'Missing market hours' }))
      if (dates.some((date, index) => Date.parse(date) !== Date.parse(first) + index * 86_400_000))
        return yield* Result.fail(
          new SignalStudyFailure({
            message: 'Continuous study requires five consecutive UTC observation days including weekends',
          }),
        )
      if (
        registration.dataRole === MatchedDataRole.Prospective &&
        Date.parse(registration.registeredAt) >= Date.parse(first)
      )
        return yield* Result.fail(
          new SignalStudyFailure({ message: 'Prospective registration must precede the first observation day' }),
        )
      return dates.flatMap((date) => {
        const session = observationSession(hours, date)
        return session === undefined ? [] : [session]
      })
    }
    const exchangeCalendars = calendars.filter((calendar) => !isContinuousMarket(calendar))
    const sessions = new Map<string, MarketCalendarSession>()
    for (const calendar of exchangeCalendars) {
      for (const session of calendar.sessions) {
        if (session.date < first || session.date > last) continue
        const existing = sessions.get(session.date)
        if (existing !== undefined && (existing.openAt !== session.openAt || existing.closeAt !== session.closeAt))
          return yield* Result.fail(new SignalStudyFailure({ message: 'Retained calendars disagree on session hours' }))
        sessions.set(session.date, session)
      }
    }
    const scheduled = [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date))
    for (const calendar of exchangeCalendars) {
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
    for (const range of exchangeCalendars
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
  readonly delayedMomentum: Outcome | null
  readonly immediateMomentum: Outcome | null
  readonly timingAvailable: boolean
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
    const delayedExecution = executionPnl(pair.momentumSymbol, pair.delayedMomentum)
    const immediateExecution = executionPnl(pair.momentumSymbol, pair.immediateMomentum)
    const complete =
      pair.modelAvailable &&
      pair.timingAvailable &&
      jevExecution !== null &&
      delayedExecution !== null &&
      immediateExecution !== null &&
      pair.inferenceCostMicros !== null &&
      pair.sharedOperatingCostMicros !== null
    if (!complete) problems.push(`incomplete-pair:${pair.batchId}`)
    const shared = BigInt(pair.sharedOperatingCostMicros ?? '0')
    const jev =
      complete && jevExecution !== null ? jevExecution - BigInt(pair.inferenceCostMicros ?? '0') - shared : null
    const delayed = complete && delayedExecution !== null ? delayedExecution - shared : null
    const immediate = complete && immediateExecution !== null ? immediateExecution - shared : null
    const delta = (left: bigint | null, right: bigint | null) =>
      left === null || right === null ? null : String(left - right)
    const stressedJev = jev === null ? null : jev - stress(pair.jev)
    const stressedDelayed = delayed === null ? null : delayed - stress(pair.delayedMomentum)
    const stressedImmediate = immediate === null ? null : immediate - stress(pair.immediateMomentum)
    return {
      batchId: pair.batchId,
      jevNetMicros: jev === null ? null : String(jev),
      delayedMomentumNetMicros: delayed === null ? null : String(delayed),
      immediateMomentumNetMicros: immediate === null ? null : String(immediate),
      selectionMicros: delta(jev, delayed),
      delayMicros: delta(delayed, immediate),
      totalMicros: delta(jev, immediate),
      stressedJevNetMicros: stressedJev === null ? null : String(stressedJev),
      stressedSelectionMicros: delta(stressedJev, stressedDelayed),
      stressedDelayMicros: delta(stressedDelayed, stressedImmediate),
      stressedTotalMicros: delta(stressedJev, stressedImmediate),
    }
  })
  const differentSelections = pairs.filter((p) => p.modelAvailable && p.jevSymbol !== p.momentumSymbol).length
  if (differentSelections < matchedEntryDefinition.minimumDifferentSelections)
    problems.push('insufficient-different-selections')
  const complete = problems.length === 0
  const mean = (
    field:
      | 'jevNetMicros'
      | 'selectionMicros'
      | 'delayMicros'
      | 'totalMicros'
      | 'stressedJevNetMicros'
      | 'stressedSelectionMicros'
      | 'stressedDelayMicros'
      | 'stressedTotalMicros',
  ) =>
    !complete
      ? null
      : (Number(paired.reduce((sum, pair) => sum + BigInt(pair[field] ?? '0'), 0n)) /
          pairs.length /
          Number(matchedEntryDefinition.budgetMicros)) *
        10_000
  const means = {
    jevNetBudgetReturnBps: mean('jevNetMicros'),
    selectionBudgetReturnBps: mean('selectionMicros'),
    delayBudgetReturnBps: mean('delayMicros'),
    totalBudgetReturnBps: mean('totalMicros'),
    stressedJevNetBudgetReturnBps: mean('stressedJevNetMicros'),
    stressedSelectionBudgetReturnBps: mean('stressedSelectionMicros'),
    stressedDelayBudgetReturnBps: mean('stressedDelayMicros'),
    stressedTotalBudgetReturnBps: mean('stressedTotalMicros'),
  }
  return {
    completion: complete ? ('COMPLETE' as const) : ('INCOMPLETE' as const),
    recommendation: !complete
      ? MatchedRecommendation.Inconclusive
      : registration.dataRole === MatchedDataRole.Development
        ? MatchedRecommendation.DevelopmentOnly
        : [
              means.jevNetBudgetReturnBps,
              means.totalBudgetReturnBps,
              means.stressedJevNetBudgetReturnBps,
              means.stressedTotalBudgetReturnBps,
            ].some((value) => value !== null && value <= 0)
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
  context: {
    observedAt: String(intradayInstantNanos(snapshot.manifest.observedAt)),
    rangeStartAt: String(intradayInstantNanos(snapshot.manifest.rangeStartAt)),
    rangeEndAt: String(intradayInstantNanos(snapshot.manifest.rangeEndAt)),
    sessionDate: snapshot.manifest.sessionDate,
    feed: snapshot.manifest.feed,
    delayClass: snapshot.manifest.delayClass,
    maximumQuoteAgeMs: snapshot.manifest.maximumQuoteAgeMs,
    candidateSymbols: snapshot.manifest.candidateSymbols ?? [],
    candidateEvidencePolicy: snapshot.manifest.candidateEvidencePolicy ?? null,
    session: exchangeSessions(snapshot.manifest.calendar)
      .filter((session) => session.date === snapshot.manifest.sessionDate)
      .map((session) => ({
        date: session.date,
        openAt: String(intradayInstantNanos(session.openAt)),
        closeAt: String(intradayInstantNanos(session.closeAt)),
      })),
  },
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
  technical:
    snapshot.manifest.streaming.technical === undefined
      ? null
      : {
          topic: snapshot.manifest.streaming.technical.topic,
          features: snapshot.manifest.streaming.technical.features.map(({ topic, partition, offset, value }) => ({
            topic,
            partition,
            offset,
            value,
          })),
        },
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
    const required = new Set([
      registration.latencyEvidenceHash,
      registration.capacityEvidenceHash,
      ...input.inventory.map((i) => i.evidenceHash),
      ...input.timings.map((entry) => entry.witness?.evidenceHash ?? null),
      ...input.timings.map((entry) => entry.witness?.decisionEvidenceHash ?? null),
      ...input.costs.flatMap((c) => [c.inference?.evidenceHash ?? null, c.sharedOperating?.evidenceHash ?? null]),
    ])
    const fs = yield* FileSystem.FileSystem
    const witnessed = new Map<string, Uint8Array>()
    for (const hash of required) {
      if (hash === null) continue
      const file = input.witnesses.find((candidate) => candidate.sha256 === hash)
      if (file === undefined)
        return yield* new SignalStudyFailure({ message: 'Referenced private witness is missing from input' })
      const bytes = yield* fs
        .readFile(file.path)
        .pipe(
          Effect.mapError(
            (cause) => new SignalStudyFailure({ message: 'Referenced private witness cannot be read', cause }),
          ),
        )
      if (sha256(bytes) !== hash)
        return yield* new SignalStudyFailure({ message: 'Referenced private witness bytes differ' })
      witnessed.set(hash, bytes)
    }
    if (registration.definitionHash !== definitionHash || registration.latencyMs !== input.study.assumptions.latencyMs)
      return yield* new SignalStudyFailure({ message: 'Frozen definition or routing assumptions differ' })
    const dates = registration.sessionDates
    const sourceHash = yield* Effect.fromResult(canonicalHashV1Result(input.study.source))
    const batches = yield* Effect.forEach(input.study.batches, (b) => Effect.fromResult(prepareSignalStudyBatch(b)))
    const batchResultHashes = new Map(
      input.study.batches.map((batch) => [batch.batchPlan.batchId, batch.batchResult?.resultHash ?? null]),
    )
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
        controlExitDefinition.protectiveStopBps !== 50 ||
        controlExitDefinition.profitTargetNetBps !== 100 ||
        protocol.flattenBeforeCloseMinutes !== 5
      )
        return yield* new SignalStudyFailure({ message: 'Matched lifecycle requires the frozen protective protocol' })
      if (!dates.includes(manifest.sessionDate))
        return yield* new SignalStudyFailure({ message: 'Observation outside registered sessions' })
      if (
        manifest.schemaVersion === 'bayn.simulated-market-snapshot.v2' &&
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
    const verifiedInventories: JevStudyInventory[] = []
    const entries = batches.filter((b) => b.observation.portfolio.purpose === JevPurpose.Entry)
    const accountBindings = new Set(
      yield* Effect.forEach(batches, (batch) =>
        Effect.fromResult(
          canonicalHashV1Result({
            schemaVersion: 'bayn.jev-study-account.v1',
            accountId: batch.observation.portfolio.brokerState.account.accountId,
          }),
        ),
      ),
    )
    if (accountBindings.size !== 1)
      return yield* new SignalStudyFailure({ message: 'Study batches belong to different accounts' })
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
      else {
        const bytes = witnessed.get(inventory.evidenceHash)
        if (bytes === undefined) return yield* new SignalStudyFailure({ message: 'Inventory witness file is missing' })
        const retained = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Unknown),
          strictParseOptions,
        )(new TextDecoder().decode(bytes)).pipe(
          Effect.flatMap((value) => Effect.fromResult(verifyJevStudyInventory(value))),
          Effect.mapError((cause) => new SignalStudyFailure({ message: 'Invalid native inventory witness', cause })),
        )
        if (
          retained.receipt.sessionDate !== inventory.sessionDate ||
          !accountBindings.has(retained.receipt.accountBindingHash) ||
          retained.batches
            .filter((batch) => batch.purpose === JevPurpose.Entry)
            .map((batch) => batch.batchId)
            .join(',') !== [...inventory.entryBatchIds].sort().join(',')
        )
          return yield* new SignalStudyFailure({
            message: 'Inventory witness differs from its account, session or claimed entries',
          })
        verifiedInventories.push(retained)
        if (retained.cycles.some((cycle) => cycle.protocolHash !== registration.protocolHash))
          problems.push(`native-inventory-protocol-mismatch:${inventory.sessionDate}`)
        if (retained.cycles.some((cycle) => cycle.state === CycleState.Pending || cycle.state === CycleState.Active))
          problems.push(`nonterminal-inventory-cycle:${inventory.sessionDate}`)
        const actualBatches = batches
          .filter((batch) => batch.snapshot.manifest.sessionDate === inventory.sessionDate)
          .map((batch) => ({
            batchId: batch.plan.batchId,
            cycleId: batch.plan.cycleId,
            observationHash: batch.plan.observationHash,
            purpose: batch.observation.portfolio.purpose,
            resultHash: batchResultHashes.get(batch.plan.batchId) ?? null,
          }))
          .sort((a, b) => a.batchId.localeCompare(b.batchId))
        if (
          (yield* Effect.fromResult(canonicalHashV1Result(actualBatches))) !==
          (yield* Effect.fromResult(canonicalHashV1Result(retained.batches)))
        )
          problems.push(`native-inventory-batch-mismatch:${inventory.sessionDate}`)
        const session = scheduled.find((value) => value.date === inventory.sessionDate)
        if (session === undefined || Date.parse(retained.receipt.asOf) < Date.parse(session.closeAt))
          problems.push(`inventory-cut-before-session-close:${inventory.sessionDate}`)
      }
    }
    for (const session of scheduled) {
      if (!inventories.has(session.date)) problems.push(`missing-session-inventory:${session.date}`)
      if (
        input.study.source.coverageStartMs > Date.parse(session.openAt) ||
        input.study.source.coverageEndMs < Date.parse(session.closeAt)
      )
        problems.push(`source-does-not-cover-session:${session.date}`)
    }
    const timings = new Map<string, typeof MatchedEntryTimingSchema.Type>()
    const timingIds = new Set<string>()
    for (const entry of input.timings) {
      const batch = entries.find((candidate) => candidate.plan.batchId === entry.batchId)
      if (timingIds.has(entry.batchId) || batch === undefined)
        return yield* new SignalStudyFailure({ message: 'Duplicate or unmatched timing witness' })
      timingIds.add(entry.batchId)
      if (entry.witness === null) continue
      const timing = entry.witness
      const bytes = witnessed.get(timing.evidenceHash)
      if (bytes === undefined) return yield* new SignalStudyFailure({ message: 'Timing witness file is missing' })
      const retained = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(EntryTimingReceiptSchema),
        strictParseOptions,
      )(new TextDecoder().decode(bytes))
      const decisionBytes = witnessed.get(timing.decisionEvidenceHash)
      if (decisionBytes === undefined)
        return yield* new SignalStudyFailure({ message: 'Committed decision witness file is missing' })
      const decision = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ExecutionDecisionDocumentSchema),
        strictParseOptions,
      )(new TextDecoder().decode(decisionBytes))
      const native = decision.strategyDecision
      const studied = input.study.batches.find((candidate) => candidate.batchPlan.batchId === batch.plan.batchId)
      if (
        decision.contentHash !== retained.decisionHash ||
        native?.schemaVersion !== 'bayn.jev-entry-target.v6' ||
        native.evidence.batchPlan.batchId !== batch.plan.batchId ||
        native.evidence.batchPlan.observationHash !== batch.plan.observationHash ||
        decision.bindings.snapshotContentHash !== batch.snapshot.manifest.contentHash ||
        intradayInstantNanos(decision.createdAt) > intradayInstantNanos(retained.decisionCommittedAt) ||
        (yield* Effect.fromResult(canonicalHashV1Result(native.evidence.batchResult))) !==
          (yield* Effect.fromResult(canonicalHashV1Result(studied?.batchResult)))
      )
        return yield* new SignalStudyFailure({
          message: 'Timing receipt does not bind the committed native entry decision',
        })
      const { evidenceHash: _evidenceHash, decisionEvidenceHash: _decisionEvidenceHash, ...claimed } = timing
      const {
        schemaVersion: _version,
        clock: _clock,
        sourceRevision,
        batchId,
        observationHash,
        snapshotHash,
        decisionHash: _decisionHash,
        ...actualTiming
      } = retained
      if (
        sourceRevision !== registration.sourceRevision ||
        batchId !== batch.plan.batchId ||
        observationHash !== batch.plan.observationHash ||
        snapshotHash !== batch.snapshot.manifest.contentHash ||
        (yield* Effect.fromResult(canonicalHashV1Result(claimed))) !==
          (yield* Effect.fromResult(canonicalHashV1Result(actualTiming)))
      )
        return yield* new SignalStudyFailure({ message: 'Timing receipt belongs to another batch, source or clock' })
      const times = [
        batch.observation.observedAt,
        timing.inputAvailableAt,
        timing.deterministicSelectedAt,
        timing.batchCompletedAt,
        timing.decisionCommittedAt,
      ].map(intradayInstantNanos)
      if (
        times.some((time, index) => index > 0 && time < (times[index - 1] ?? 0n)) ||
        timing.batchCompletedAt !==
          input.study.batches.find((entry) => entry.batchPlan.batchId === batch.plan.batchId)?.batchResult
            ?.completedAt ||
        timing.deterministicSymbol !== batch.selected[SignalScreenRule.RelativeMomentum]
      )
        return yield* new SignalStudyFailure({ message: 'Timing witness differs from the frozen selection or batch' })
      timings.set(entry.batchId, timing)
    }
    for (const batch of entries)
      if (!timings.has(batch.plan.batchId)) problems.push(`missing-entry-timing:${batch.plan.batchId}`)
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
              universe: jevMarketForFeed(manifest.feed).universe,
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
      const timing = timings.get(batch.plan.batchId)
      const arms = [
        {
          arm: MatchedArm.Jev,
          symbol: batch.selected[SignalScreenRule.Jev],
          at: timing?.decisionCommittedAt ?? batch.decidedAt,
        },
        {
          arm: MatchedArm.DelayedMomentum,
          symbol: batch.selected[SignalScreenRule.RelativeMomentum],
          at: timing?.decisionCommittedAt ?? batch.decidedAt,
        },
        ...(timing === undefined
          ? []
          : [
              {
                arm: MatchedArm.ImmediateMomentum,
                symbol: timing.deterministicSymbol,
                at: timing.deterministicSelectedAt,
              },
            ]),
      ]
      for (const { arm, symbol, at } of arms) {
        if (symbol === null) continue
        states.set(arm, yield* Effect.fromResult(createMatchedLifecycle(matchedEntryDefinition.budgetMicros)))
        const terms: MatchedTerms = {
          symbol,
          protocol: batch.observation.protocol,
          assumptions: input.study.assumptions,
          entryBudgetMicros: matchedEntryDefinition.budgetMicros,
          decidedAtMs: Date.parse(at),
          cutoffMs: isContinuousMarket(manifest.calendar)
            ? Number.POSITIVE_INFINITY
            : Date.parse(session.closeAt) - 5 * 60_000,
          closeMs: isContinuousMarket(manifest.calendar)
            ? Date.parse(at) +
              registration.latencyMs +
              batch.observation.protocol.maximumHoldingMinutes * 60_000 +
              continuousExecutionPolicy.closeRecoveryMs
            : Date.parse(session.closeAt),
        }
        const event = (kind: MatchedEvent, atMs: number) =>
          add(
            atMs,
            Effect.gen(function* () {
              const state = states.get(arm)
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
                arm,
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
      const finish = (arm: MatchedArm) => {
        const state = states?.get(arm)
        return state === undefined ? null : finishMatchedLifecycle(state)
      }
      const cost = costs.get(batch.plan.batchId)
      return {
        batchId: batch.plan.batchId,
        sessionDate: batch.snapshot.manifest.sessionDate,
        jevSymbol,
        momentumSymbol,
        modelAvailable:
          batch.modelStatus === 'AVAILABLE' &&
          Date.parse(timings.get(batch.plan.batchId)?.decisionCommittedAt ?? batch.decidedAt) <
            Date.parse(batch.plan.expiresAt),
        timingAvailable: timings.has(batch.plan.batchId),
        timing: timings.get(batch.plan.batchId) ?? null,
        jev: finish(MatchedArm.Jev),
        delayedMomentum: finish(MatchedArm.DelayedMomentum),
        immediateMomentum: finish(MatchedArm.ImmediateMomentum),
        inferenceCostMicros: cost?.inference?.unresolvedCount === 0 ? cost.inference.costMicros : null,
        sharedOperatingCostMicros:
          cost?.sharedOperating?.unresolvedCount === 0 ? cost.sharedOperating.costMicros : null,
      }
    })
    const report = {
      schemaVersion: 'bayn.matched-entry-study.v8',
      definition: matchedEntryDefinition,
      definitionHash,
      registration,
      registrationHash: yield* Effect.fromResult(canonicalHashV1Result(registration)),
      inputHash: yield* Effect.fromResult(canonicalHashV1Result(input)),
      sourceReceiptHash: receipt.contentHash,
      sourceManifestHash: sourceHash,
      sourceRecordCount: input.study.source.recordCount,
      inventories: verifiedInventories,
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
