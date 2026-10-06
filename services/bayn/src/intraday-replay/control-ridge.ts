import { Result, Schema } from 'effect'

import {
  MarketCalendarResponseSchema,
  type MarketCalendarObservation,
  type MarketCalendarSession,
} from '../broker/alpaca/model'
import { normalizeMarketCalendarResult } from '../broker/alpaca/normalizers'
import type { EntryTurnoverPolicy } from '../execution/turnover-reserve'
import { canonicalHashV1Result } from '../hash'
import type { JevProtocol } from '../jev/protocol'
import type { IntradaySnapshotQuery } from '../market-data/intraday/model'
import type { HistoricalMarketCursor } from '../market-data/streaming/historical'
import type { Policy } from '../risk'
import { GitSourceRevisionSchema, Sha256Schema, strictParseOptions } from '../schemas'
import { utcInstantFromEpochMillis } from '../time'
import type { BacktestInputSchema } from './backtest'
import {
  extractSixBarResearchObservation,
  sixBarResearchDefinition,
  SixBarResearchStatus,
  SixBarUnavailableReason,
} from './six-bar-features'
import {
  decodeSixBarRidgeArtifact,
  scoreSixBarRidge,
  SixBarRidgeArtifactSchema,
  SixBarRidgeFailure,
  type SixBarRidgeFeatureSchema,
  SixBarRidgePartition,
} from './six-bar-ridge'
import type { BacktestSourceManifest } from './source'
import { signalStudyDefinition } from './signal-study'

export enum RidgeControlPolicy {
  Ridge = 'SIX_BAR_RIDGE_V1',
  TrainingMean = 'SIX_BAR_TRAINING_MEAN_V1',
}

export const BoundRidgeInputSchema = Schema.Struct({
  artifact: SixBarRidgeArtifactSchema,
  expectedArtifact: Schema.Struct({
    artifactHash: Sha256Schema,
    manifestHash: Sha256Schema,
    sourceRevision: GitSourceRevisionSchema,
  }),
  calendar: MarketCalendarResponseSchema,
  expectedCalendarHash: Sha256Schema,
  evaluationSourceManifestHash: Sha256Schema,
  partition: Schema.Literals([SixBarRidgePartition.Validation, SixBarRidgePartition.Holdout]),
})

export interface RidgeExecutionContext {
  readonly protocol: JevProtocol
  readonly risk: Policy
  readonly pollIntervalMs: number
  readonly decisionLatencyMs: number
  readonly turnoverPolicy: EntryTurnoverPolicy
  readonly assumptions: typeof BacktestInputSchema.Type.assumptions
}

export const ridgeExecutionLabelDefinition = (context: RidgeExecutionContext, allocationBudgetMicros: string) => ({
  schemaVersion: 'bayn.six-bar-ridge-execution-label.v1',
  allocationBudgetMicros,
  target: '10000 * net-execution-pnl / fixed-allocation-budget',
  allocation: 'Whole shares bounded by fixed adverse-limit principal, current cash including fees, and native risk.',
  noEntryFill: 'Zero execution P&L; the fixed allocation denominator is retained.',
  pollIntervalMs: context.pollIntervalMs,
  decisionLatencyMs: context.decisionLatencyMs,
  turnoverPolicy: context.turnoverPolicy,
  assumptions: context.assumptions,
  executionModel: context.protocol.executionModel,
  executionLimitSlippageBps: signalStudyDefinition.limitSlippageBps,
  eligibility: {
    lookbackMinutes: context.protocol.lookbackMinutes,
    decisionDelaySeconds: context.protocol.decisionDelaySeconds,
    entryCutoffMinutesBeforeClose: context.protocol.entryCutoffMinutesBeforeClose,
    inferenceValidityMs: context.protocol.inferenceValidityMs,
    maximumQuoteAgeMs: context.protocol.maximumQuoteAgeMs,
  },
  exits: {
    maximumHoldingMinutes: context.protocol.maximumHoldingMinutes,
    protectiveStopBps: context.protocol.protectiveStopBps,
    sessionCloseMinutesBeforeClose: context.protocol.entryCutoffMinutesBeforeClose,
    lifecycle: 'One position, persistent partial-exit retries, consumed quote liquidity, and serial current cash.',
  },
  risk: {
    maximumGrossWeight: context.protocol.maximumGrossWeight,
    maximumSymbolWeight: context.protocol.maximumSymbolWeight,
    maxOrderNotionalMicros: context.risk.maxOrderNotionalMicros,
    maxSymbolExposureMicros: context.risk.maxSymbolExposureMicros,
    maxGrossExposureMicros: context.risk.maxGrossExposureMicros,
    maxNetExposureMicros: context.risk.maxNetExposureMicros,
    maxDailyTradedNotionalMicros: context.risk.maxDailyTradedNotionalMicros,
    maxAdverseSlippageBps: context.risk.maxAdverseSlippageBps,
    maxDailyLossMicros: context.risk.maxDailyLossMicros,
    maxDrawdownMicros: context.risk.maxDrawdownMicros,
  },
})

const fail = (message: string, cause?: unknown) => new SixBarRidgeFailure({ message, cause })
const sameSession = (left: MarketCalendarSession, right: MarketCalendarSession) =>
  left.date === right.date && left.openAt === right.openAt && left.closeAt === right.closeAt

export const prepareBoundRidge = (
  raw: unknown,
  context: RidgeExecutionContext & {
    readonly source: BacktestSourceManifest
    readonly calendar: MarketCalendarObservation
    readonly sessions: readonly MarketCalendarSession[]
  },
) =>
  Result.gen(function* () {
    const input = yield* Schema.decodeUnknownResult(BoundRidgeInputSchema, strictParseOptions)(raw)
    yield* decodeSixBarRidgeArtifact(input.artifact, input.expectedArtifact)
    const artifact = input.artifact
    const dates = input.calendar.map((session) => session.date).sort()
    const first = dates[0]
    const last = dates.at(-1)
    if (first === undefined || last === undefined) return yield* Result.fail(fail('Ridge calendar is empty'))
    const calendar = yield* normalizeMarketCalendarResult(input.calendar, { start: first, end: last })
    if (
      calendar.normalizedResponseHash !== input.expectedCalendarHash ||
      input.expectedCalendarHash !== artifact.provenance.calendarHash ||
      context.source.transport !== 'original-capture' ||
      context.source.deliveryModel.schemaVersion !== 'bayn.original-capture-arrivals.v1' ||
      (yield* canonicalHashV1Result(context.source)) !== input.evaluationSourceManifestHash ||
      context.protocol.lookbackMinutes !== 30 ||
      context.protocol.decisionDelaySeconds !== 2 ||
      context.protocol.benchmarkSymbol !== sixBarResearchDefinition.benchmarkSymbol ||
      !Number.isSafeInteger(context.pollIntervalMs) ||
      context.pollIntervalMs <= 0 ||
      context.pollIntervalMs > 60_000 ||
      (yield* canonicalHashV1Result(ridgeExecutionLabelDefinition(context, artifact.allocationBudgetMicros))) !==
        artifact.provenance.labelDefinitionHash
    )
      return yield* Result.fail(fail('Ridge source, calendar, eligibility or execution-label binding differs'))
    for (const training of artifact.trainingSessions)
      if (!calendar.sessions.some((session) => session.date === training.date))
        return yield* Result.fail(fail('Ridge calendar omits a declared training session'))
    for (const declared of artifact.evaluationSessions) {
      const session = calendar.sessions.find((entry) => entry.date === declared.date)
      if (session === undefined || !sameSession(session, declared))
        return yield* Result.fail(fail('Ridge calendar differs from a declared evaluation session'))
    }
    const firstIndex = calendar.sessions.findIndex((session) => session.date === context.sessions[0]?.date)
    const lastIndex = calendar.sessions.findIndex((session) => session.date === context.sessions.at(-1)?.date)
    const executionCalendar = calendar.sessions.slice(firstIndex, lastIndex + 2)
    if (
      firstIndex < 0 ||
      lastIndex < firstIndex ||
      calendar.sessions[lastIndex + 1] === undefined ||
      context.sessions.length !== lastIndex - firstIndex + 1 ||
      context.calendar.sessions.length !== executionCalendar.length ||
      context.calendar.sessions.some((session, index) => {
        const expected = executionCalendar[index]
        return expected === undefined || !sameSession(session, expected)
      })
    )
      return yield* Result.fail(fail('Ridge execution calendar must retain consecutive dates and their next session'))
    for (const [index, session] of context.sessions.entries()) {
      const expected = executionCalendar[index]
      const declared = artifact.evaluationSessions.find((entry) => entry.date === session.date)
      const firstPoll =
        Date.parse(session.openAt) +
        Math.ceil(
          (context.protocol.lookbackMinutes * 60_000 + context.protocol.decisionDelaySeconds * 1000) /
            context.pollIntervalMs,
        ) *
          context.pollIntervalMs
      if (
        expected === undefined ||
        !sameSession(session, expected) ||
        declared === undefined ||
        declared.partition !== input.partition ||
        declared.firstDecisionAt !== utcInstantFromEpochMillis(firstPoll)
      )
        return yield* Result.fail(fail('Ridge execution session, partition or first eligible poll differs'))
    }
    return { ...input, calendar, candidateSymbols: context.protocol.candidateSymbols }
  }).pipe(Result.mapError((cause) => fail('Cannot bind offline Ridge controls', cause)))

export type BoundRidge = Result.Result.Success<ReturnType<typeof prepareBoundRidge>>
type Observation = Result.Result.Success<ReturnType<typeof extractSixBarResearchObservation>>
export const isCandidateExclusion = (observation: Observation) =>
  observation.status !== SixBarResearchStatus.Available &&
  observation.symbol === observation.candidateSymbol &&
  (observation.status === SixBarResearchStatus.Excluded ||
    observation.reason === SixBarUnavailableReason.Bars ||
    observation.reason === SixBarUnavailableReason.Quote ||
    observation.reason === SixBarUnavailableReason.Trade ||
    observation.reason === SixBarUnavailableReason.Freshness)
export const featureRowFromObservation = (
  observation: Extract<Observation, { status: SixBarResearchStatus.Available }>,
) => ({
  sessionDate: observation.query.sessionDate,
  symbol: observation.candidateSymbol,
  featureDefinitionHash: observation.definitionHash,
  featureEvidenceHash: observation.evidenceHash,
  sourceManifestHash: observation.source.sourceManifestHash,
  calendarHash: observation.query.calendar.normalizedResponseHash,
  availableAt: utcInstantFromEpochMillis(Math.max(...observation.receipts.map((receipt) => receipt.availableAtMs))),
  decisionAt: observation.query.observedAt,
  values: observation.values,
})

export const scorePinnedRidgeCandidates = (
  bound: BoundRidge,
  query: Pick<IntradaySnapshotQuery, 'sessionDate' | 'observedAt'>,
  candidates: readonly (typeof SixBarRidgeFeatureSchema.Type)[],
  requiredFeatureRowHashes: readonly string[],
  policy: RidgeControlPolicy,
) =>
  Result.gen(function* () {
    const binding = {
      artifact: bound.expectedArtifact,
      evaluation: {
        sourceManifestHash: bound.evaluationSourceManifestHash,
        calendarHash: bound.expectedCalendarHash,
        requiredFeatureRowHashes,
        sessionDate: query.sessionDate,
        partition: bound.partition,
        decisionAt: query.observedAt,
      },
    }
    yield* scoreSixBarRidge(bound.artifact, [], {
      ...binding,
      evaluation: { ...binding.evaluation, requiredFeatureRowHashes: [] },
    })
    const session = bound.artifact.evaluationSessions.find((entry) => entry.date === query.sessionDate)
    const expected = new Set(requiredFeatureRowHashes)
    const actual = yield* Result.all(candidates.map((candidate) => canonicalHashV1Result(candidate)))
    if (
      session === undefined ||
      expected.size !== requiredFeatureRowHashes.length ||
      candidates.length !== expected.size ||
      new Set(actual).size !== actual.length ||
      new Set(candidates.map((candidate) => candidate.symbol)).size !== candidates.length ||
      actual.some((hash) => !expected.has(hash)) ||
      candidates.some(
        (candidate) =>
          !bound.candidateSymbols.includes(candidate.symbol) ||
          candidate.sessionDate !== query.sessionDate ||
          candidate.decisionAt !== query.observedAt ||
          candidate.availableAt < session.openAt ||
          candidate.availableAt > query.observedAt ||
          candidate.sourceManifestHash !== bound.evaluationSourceManifestHash ||
          candidate.calendarHash !== bound.expectedCalendarHash ||
          candidate.featureDefinitionHash !== bound.artifact.featureDefinitionHash,
      )
    )
      return yield* Result.fail(fail('Ridge control candidates differ from their original verified extraction pins'))
    if (policy === RidgeControlPolicy.TrainingMean)
      return candidates
        .map(({ symbol }) => ({ symbol, scoreBps: bound.artifact.trainingTargetMeanBps }))
        .sort((left, right) => (left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0))
    return (yield* scoreSixBarRidge(bound.artifact, candidates, binding)).scores
  })

export const selectBoundRidge = (
  cursor: HistoricalMarketCursor,
  query: IntradaySnapshotQuery,
  bound: BoundRidge,
  policy: RidgeControlPolicy,
) =>
  Result.gen(function* () {
    if (
      cursor.source?.sourceManifestHash !== bound.evaluationSourceManifestHash ||
      query.candidateSymbols === undefined ||
      query.candidateSymbols.join(',') !== bound.candidateSymbols.join(',') ||
      query.candidateSymbols.length === 0 ||
      new Set(query.candidateSymbols).size !== query.candidateSymbols.length
    )
      return yield* Result.fail(fail('Ridge decision has a different source or invalid candidate universe'))
    const binding = {
      artifact: bound.expectedArtifact,
      evaluation: {
        sourceManifestHash: bound.evaluationSourceManifestHash,
        calendarHash: bound.expectedCalendarHash,
        requiredFeatureRowHashes: [],
        sessionDate: query.sessionDate,
        partition: bound.partition,
        decisionAt: query.observedAt,
      },
    }
    yield* scoreSixBarRidge(bound.artifact, [], binding)
    const observations: Observation[] = []
    const requiredFeatureRowHashes: string[] = []
    for (const symbol of query.candidateSymbols) {
      const observation = yield* extractSixBarResearchObservation(cursor, {
        ...query,
        calendar: bound.calendar,
        rangeStartAt: utcInstantFromEpochMillis(Date.parse(query.rangeEndAt) - 6 * 60_000),
        symbols: [symbol, sixBarResearchDefinition.benchmarkSymbol].sort(),
        candidateSymbols: [symbol],
        candidateEvidencePolicy: sixBarResearchDefinition.candidateEvidencePolicy,
        maximumQuoteAgeMs: sixBarResearchDefinition.maximumQuoteAgeMs,
        minimumWatermarkLagMs: sixBarResearchDefinition.minimumWatermarkLagMs,
      })
      if (
        observation.source.sourceManifestHash !== bound.evaluationSourceManifestHash ||
        observation.query.calendar.normalizedResponseHash !== bound.expectedCalendarHash ||
        observation.definitionHash !== bound.artifact.featureDefinitionHash
      )
        return yield* Result.fail(fail('Ridge feature observation differs from the bound evaluation'))
      if (observation.status === SixBarResearchStatus.Available)
        requiredFeatureRowHashes.push(yield* canonicalHashV1Result(featureRowFromObservation(observation)))
      observations.push(observation)
    }
    if (
      observations.some(
        (observation) => observation.status !== SixBarResearchStatus.Available && !isCandidateExclusion(observation),
      )
    )
      return { status: 'UNAVAILABLE' as const, observations }
    const candidates = observations.flatMap((observation) =>
      observation.status === SixBarResearchStatus.Available ? [featureRowFromObservation(observation)] : [],
    )
    const scores = yield* scorePinnedRidgeCandidates(bound, query, candidates, requiredFeatureRowHashes, policy)
    const best = scores[0]
    const evidence = {
      schemaVersion: 'bayn.ridge-control-selection.v1',
      qualification: 'UNQUALIFIED',
      controllerCoverage: 'UNKNOWN',
      policy,
      artifactHash: bound.artifact.artifactHash,
      scores,
      requiredFeatureRowHashes,
      observations,
      exclusions: observations.flatMap((observation) =>
        observation.status !== SixBarResearchStatus.Available && isCandidateExclusion(observation)
          ? [
              {
                symbol: observation.candidateSymbol,
                inputSymbol: observation.symbol,
                reason: observation.reason,
                evidenceHash: observation.evidenceHash,
              },
            ]
          : [],
      ),
      selectedSymbol: best !== undefined && best.scoreBps > 0 ? best.symbol : null,
    } as const
    return {
      status: 'AVAILABLE' as const,
      evidence,
      evidenceHash: yield* canonicalHashV1Result(evidence),
    }
  }).pipe(Result.mapError((cause) => fail('Cannot select offline Ridge control', cause)))
